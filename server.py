import asyncio
import importlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
from typing import Any, Dict, List, Optional

import httpx
import yt_dlp
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# ---------------------------------------------------------------------------
# Auto-upgrade yt-dlp if an older version (< 2026.8) is installed locally
# ---------------------------------------------------------------------------
try:
    _ver_parts = [int(re.sub(r"\D", "", p) or "0") for p in yt_dlp.version.__version__.split(".")[:3]]
    if tuple(_ver_parts[:2]) < (2026, 8):
        print(
            f"[StudyDocs] Detected old yt-dlp ({yt_dlp.version.__version__}). Upgrading to latest yt-dlp[default]..."
        )
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--upgrade", "yt-dlp[default]"],
            check=False,
        )
        importlib.reload(yt_dlp)
        print(f"[StudyDocs] Reloaded yt-dlp version: {yt_dlp.version.__version__}")
except Exception as _e:
    print(f"[StudyDocs] yt-dlp version check skipped: {_e}")

# Locate FFmpeg binary from imageio-ffmpeg or system PATH
FFMPEG_EXE: Optional[str] = None
try:
    import imageio_ffmpeg

    FFMPEG_EXE = imageio_ffmpeg.get_ffmpeg_exe()
except Exception:
    FFMPEG_EXE = shutil.which("ffmpeg")

# Ensure Deno JS runtime is available on Linux cloud containers (Gradio SDK / Render Native Python)
if sys.platform.startswith("linux") and not shutil.which("deno"):
    _deno_dir = os.path.join(tempfile.gettempdir(), "deno_install")
    _deno_bin = os.path.join(_deno_dir, "bin", "deno")
    if not os.path.exists(_deno_bin):
        try:
            subprocess.run(
                f"curl -fsSL https://deno.land/install.sh | DENO_INSTALL={_deno_dir} sh",
                shell=True,
                check=False,
                timeout=30,
            )
        except Exception:
            pass
    if os.path.exists(_deno_bin):
        os.environ["PATH"] = os.path.join(_deno_dir, "bin") + os.pathsep + os.environ.get("PATH", "")

MUX_CACHE_DIR = os.path.join(tempfile.gettempdir(), "studydocs_mux_cache")
os.makedirs(MUX_CACHE_DIR, exist_ok=True)
MUX_LOCKS: Dict[str, asyncio.Lock] = {}
MAX_MUX_CACHE_FILES = 3

SERVER_START_TIME = time.time()
COOKIES_FILE_PATH = os.path.join(tempfile.gettempdir(), "studydocs_youtube_cookies.txt")

# Initialize cookies file from environment variable YOUTUBE_COOKIES or local cookies.txt if present
if os.environ.get("YOUTUBE_COOKIES", "").strip():
    try:
        with open(COOKIES_FILE_PATH, "w", encoding="utf-8") as _cf:
            _cf.write(os.environ["YOUTUBE_COOKIES"].strip() + "\n")
    except Exception:
        pass
elif os.path.exists("cookies.txt") and os.path.getsize("cookies.txt") > 32:
    try:
        shutil.copyfile("cookies.txt", COOKIES_FILE_PATH)
    except Exception:
        pass


def get_active_cookiefile() -> Optional[str]:
    if os.path.exists(COOKIES_FILE_PATH) and os.path.getsize(COOKIES_FILE_PATH) > 32:
        return COOKIES_FILE_PATH
    return None


app = FastAPI(title="StudyDocs Media Proxy Workspace", version="2.5.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def disable_static_cache(request: Request, call_next):
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response


# ---------------------------------------------------------------------------
# In-memory Caches (to make repeated lookups & range requests instantaneous)
# ---------------------------------------------------------------------------
VIDEO_CACHE: Dict[str, Dict[str, Any]] = {}
SEARCH_CACHE: Dict[str, Dict[str, Any]] = {}
COMMENTS_CACHE: Dict[str, Dict[str, Any]] = {}
THUMB_CACHE: Dict[str, bytes] = {}

VIDEO_CACHE_TTL = 1800  # 30 minutes (YouTube signed URLs last ~6 hours)
SEARCH_CACHE_TTL = 900  # 15 minutes
COMMENTS_CACHE_TTL = 1800

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

http_client = httpx.AsyncClient(
    headers={"User-Agent": USER_AGENT, "Accept-Language": "ja,en-US;q=0.9,en;q=0.8"},
    follow_redirects=True,
    timeout=httpx.Timeout(25.0, connect=8.0),
    limits=httpx.Limits(max_keepalive_connections=40, max_connections=100),
)

# YouTube DASH URLs (c=VISIONOS / c=ANDROID) require explicit bounded byte ranges
STREAM_CHUNK_WINDOW = 4 * 1024 * 1024  # 4 MB per range request

CATEGORY_QUERIES = {
    "trending": "日本 人気 急上昇 トレンド 動画 2026",
    "music": "J-POP 人気 MV Official Music Video 2026",
    "gaming": "ゲーム実況 人気 トレンド 日本",
    "education": "解説 講義 教養 科学 歴史 わかりやすい",
    "news": "ニュース 解説 最新 日本 経済 IT",
    "lofi": "勉強用BGM カフェ 作業用 lofi hip hop beats",
}


def extract_video_id(text: str) -> Optional[str]:
    text = text.strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", text):
        return text
    patterns = [
        r"(?:v=|\/v\/|youtu\.be\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})",
    ]
    for p in patterns:
        m = re.search(p, text)
        if m:
            return m.group(1)
    return None


def _sync_search(query: str, max_results: int = 16) -> List[Dict[str, Any]]:
    ydl_opts: Dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": True,
        "skip_download": True,
    }
    cfile = get_active_cookiefile()
    if cfile:
        ydl_opts["cookiefile"] = cfile
    search_spec = f"ytsearch{max_results}:{query}"
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(search_spec, download=False)
        entries = info.get("entries") or []
        results = []
        for e in entries:
            if not e:
                continue
            vid = e.get("id")
            if not vid or len(vid) != 11:
                continue
            results.append({
                "id": vid,
                "title": e.get("title") or "無題の動画",
                "channel": e.get("uploader") or e.get("channel") or "YouTube",
                "channelId": e.get("channel_id") or "",
                "duration": e.get("duration") or 0,
                "viewCount": e.get("view_count") or 0,
                "thumbnail": f"/api/thumb/{vid}?q=hq",
            })
            if len(results) >= max_results:
                break
        return results


def _sync_extract_video(video_id: str) -> Dict[str, Any]:
    url = f"https://www.youtube.com/watch?v={video_id}"
    cfile = get_active_cookiefile()

    client_profiles = [
        ["default", "android"],
        ["tv_embedded", "ios", "mweb"],
    ]

    info = None
    last_err = None
    for clients in client_profiles:
        ydl_opts: Dict[str, Any] = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "extractor_args": {
                "youtube": {
                    "player_client": clients,
                }
            },
        }
        if cfile:
            ydl_opts["cookiefile"] = cfile
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
            if info and (info.get("formats") or info.get("url")):
                break
        except Exception as e:
            last_err = e
            continue

    if not info:
        raise RuntimeError(str(last_err or "Failed to extract video info"))

    formats_raw = info.get("formats") or []
    streams: Dict[str, Dict[str, Any]] = {}

    target_itags = {"18", "133", "134", "135", "136", "137", "140", "139", "251", "250"}

    for f in formats_raw:
        fid = str(f.get("format_id") or "")
        furl = f.get("url")
        if not furl:
            continue
        proto = f.get("protocol") or ""
        base_fid = fid.split("-")[0]
        if fid in target_itags or base_fid in ("140", "251", "139") or (
            proto in ("https", "http")
            and f.get("vcodec") != "none"
            and f.get("acodec") != "none"
        ):
            ext = f.get("ext") or "mp4"
            vcodec = f.get("vcodec") or "none"
            acodec = f.get("acodec") or "none"
            if vcodec == "none":
                mime = "audio/mp4" if ext in ("m4a", "mp4") else f"audio/{ext}"
            else:
                mime = f"video/{ext}"

            exact_size = int(f.get("filesize") or 0)

            entry_obj = {
                "itag": fid,
                "url": furl,
                "ext": ext,
                "resolution": f.get("resolution") or "",
                "height": f.get("height") or 0,
                "vcodec": vcodec,
                "acodec": acodec,
                "filesize": exact_size,
                "headers": f.get("http_headers") or {},
                "mime": mime,
            }
            # Prefer non-ANDROID stream if multiple formats share the same base_fid
            if fid not in streams or "c=ANDROID" not in furl:
                streams[fid] = entry_obj
            if base_fid in ("140", "251", "139"):
                if base_fid not in streams or "c=ANDROID" not in furl:
                    streams[base_fid] = entry_obj

    subtitles_out: Dict[str, Dict[str, str]] = {}
    manual_subs = info.get("subtitles") or {}
    auto_subs = info.get("automatic_captions") or {}

    for lang_code, lang_label in [("ja", "日本語"), ("en", "英語 (English)")]:
        track_list = manual_subs.get(lang_code) or auto_subs.get(lang_code) or []
        is_auto = lang_code not in manual_subs
        vtt_url = None
        for t in track_list:
            if t.get("ext") == "vtt" and t.get("url"):
                vtt_url = t["url"]
                break
        if vtt_url:
            subtitles_out[lang_code] = {
                "lang": lang_code,
                "label": f"{lang_label}{' (自動生成)' if is_auto else ''}",
                "vtt_url": vtt_url,
                "proxy_url": f"/api/subtitles/{video_id}?lang={lang_code}",
            }

    # Prefer m4a AAC (140 / 139) for clean MP4 muxing; fallback to 251
    mux_audio_itag = (
        "140" if "140" in streams else ("139" if "139" in streams else ("251" if "251" in streams else None))
    )
    audio_only_itag = mux_audio_itag or ("18" if "18" in streams else "140")

    qualities = []
    # When FFmpeg is available, mux video + audio on the server into a single MP4 stream
    # so the browser <video> tag receives a unified video+audio MP4 for EVERY resolution!
    use_server_mux = bool(FFMPEG_EXE and mux_audio_itag)

    quality_defs = [
        ("133", "240p_dash", "240p 軽量 (通信節約)", 240),
        ("134", "360p_dash", "360p 標準 (音声統合MP4)", 360),
        ("135", "480p_dash", "480p SD (標準高画質・音声統合)", 480),
        ("136", "720p_dash", "720p HD (高画質・音声統合)", 720),
        ("137", "1080p_dash", "1080p Full HD (最高画質・音声統合)", 1080),
    ]

    for v_itag, q_id, q_label, q_height in quality_defs:
        if v_itag in streams:
            if use_server_mux:
                qualities.append({
                    "id": q_id,
                    "label": q_label,
                    "videoItag": f"mux_{v_itag}_{mux_audio_itag}",
                    "audioItag": None,
                    "height": q_height,
                })
            else:
                qualities.append({
                    "id": q_id,
                    "label": q_label,
                    "videoItag": v_itag,
                    "audioItag": audio_only_itag,
                    "height": q_height,
                })

    if not qualities and "18" in streams:
        qualities.append({
            "id": "360p_combined",
            "label": "360p 標準",
            "videoItag": "18",
            "audioItag": None,
            "height": 360,
        })

    chapters = []
    for ch in info.get("chapters") or []:
        chapters.append({
            "title": ch.get("title") or "",
            "start_time": ch.get("start_time") or 0,
            "end_time": ch.get("end_time") or 0,
        })

    upload_date_raw = info.get("upload_date") or ""
    upload_date_fmt = (
        f"{upload_date_raw[:4]}/{upload_date_raw[4:6]}/{upload_date_raw[6:8]}"
        if len(upload_date_raw) == 8
        else upload_date_raw
    )

    return {
        "id": video_id,
        "title": info.get("title") or "無題の動画",
        "description": info.get("description") or "",
        "channel": info.get("uploader") or info.get("channel") or "YouTube Channel",
        "channelId": info.get("channel_id") or info.get("uploader_id") or "",
        "subscriberCount": info.get("channel_follower_count") or 0,
        "viewCount": info.get("view_count") or 0,
        "likeCount": info.get("like_count") or 0,
        "duration": info.get("duration") or 0,
        "uploadDate": upload_date_fmt,
        "thumbnail": f"/api/thumb/{video_id}?q=maxres",
        "tags": (info.get("tags") or [])[:12],
        "chapters": chapters,
        "qualities": qualities,
        "audioItag": audio_only_itag,
        "subtitles": list(subtitles_out.values()),
        "_internal_streams": streams,
        "_internal_subtitles": subtitles_out,
        "_cached_at": time.time(),
    }


def _sync_extract_comments(video_id: str, max_count: int = 25) -> List[Dict[str, Any]]:
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "ignore_no_formats_error": True,
        "getcomments": True,
        "extractor_args": {
            "youtube": {
                "max_comments": [str(max_count), str(max_count), "0", "0"],
                "comment_sort": ["top"],
            }
        },
    }
    url = f"https://www.youtube.com/watch?v={video_id}"
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)
        raw_comments = info.get("comments") or []
        out = []
        for c in raw_comments[:max_count]:
            thumb = c.get("author_thumbnail") or ""
            proxied_avatar = (
                f"/api/avatar?url={urllib.parse.quote(thumb)}" if thumb else ""
            )
            out.append({
                "id": c.get("id") or "",
                "author": c.get("author") or "匿名ユーザー",
                "avatar": proxied_avatar,
                "text": c.get("text") or "",
                "likeCount": c.get("like_count") or 0,
                "timeText": c.get("_time_text") or "",
                "isPinned": bool(c.get("is_pinned")),
            })
        return out


async def get_cached_video(video_id: str) -> Dict[str, Any]:
    now = time.time()
    cached = VIDEO_CACHE.get(video_id)
    if cached and (now - cached.get("_cached_at", 0)) < VIDEO_CACHE_TTL:
        return cached
    data = await asyncio.to_thread(_sync_extract_video, video_id)
    VIDEO_CACHE[video_id] = data
    return data


def _cleanup_mux_cache():
    try:
        entries = []
        for fn in os.listdir(MUX_CACHE_DIR):
            fp = os.path.join(MUX_CACHE_DIR, fn)
            if os.path.isfile(fp) and not fn.endswith(".tmp"):
                entries.append((os.path.getmtime(fp), fp))
        if len(entries) > MAX_MUX_CACHE_FILES:
            entries.sort(key=lambda x: x[0])
            for _, old_fp in entries[: len(entries) - MAX_MUX_CACHE_FILES]:
                try:
                    os.remove(old_fp)
                except OSError:
                    pass
    except Exception:
        pass


async def _fetch_range_with_retry(
    url: str, base_headers: Dict[str, str], start: int, end: int, retries: int = 3
) -> httpx.Response:
    last_exc = None
    for attempt in range(retries):
        try:
            hdrs = dict(base_headers)
            hdrs["Range"] = f"bytes={start}-{end}"
            resp = await http_client.get(url, headers=hdrs)
            if resp.status_code in (200, 206):
                return resp
            if attempt < retries - 1:
                await asyncio.sleep(0.2 * (attempt + 1))
        except Exception as e:
            last_exc = e
            if attempt < retries - 1:
                await asyncio.sleep(0.2 * (attempt + 1))
    if last_exc:
        raise last_exc
    return resp


async def fetch_full_stream_bytes(video_id: str, itag: str) -> bytes:
    data = await get_cached_video(video_id)
    streams = data.get("_internal_streams") or {}
    stream_info = streams.get(itag)
    if not stream_info:
        raise HTTPException(status_code=404, detail=f"Stream itag={itag} not found")

    url = stream_info["url"]
    headers = dict(stream_info.get("headers") or {})
    known_size = int(stream_info.get("filesize") or 0)

    first_end = STREAM_CHUNK_WINDOW - 1
    if known_size > 0 and first_end >= known_size:
        first_end = known_size - 1

    first_resp = await _fetch_range_with_retry(url, headers, 0, first_end)
    if first_resp.status_code in (403, 416):
        VIDEO_CACHE.pop(video_id, None)
        data = await get_cached_video(video_id)
        stream_info = (data.get("_internal_streams") or {}).get(itag)
        if not stream_info:
            raise HTTPException(status_code=502, detail=f"Stream refresh failed for itag={itag}")
        url = stream_info["url"]
        headers = dict(stream_info.get("headers") or {})
        known_size = int(stream_info.get("filesize") or 0)
        first_end = STREAM_CHUNK_WINDOW - 1
        if known_size > 0 and first_end >= known_size:
            first_end = known_size - 1
        first_resp = await _fetch_range_with_retry(url, headers, 0, first_end)

    if first_resp.status_code not in (200, 206):
        raise HTTPException(
            status_code=first_resp.status_code,
            detail=f"Upstream googlevideo returned HTTP {first_resp.status_code} for itag={itag}",
        )

    total_size = known_size
    cr = first_resp.headers.get("content-range", "")
    if "/" in cr:
        try:
            total_size = int(cr.split("/")[-1])
            stream_info["filesize"] = total_size
        except ValueError:
            pass

    first_chunk = first_resp.content
    if total_size <= len(first_chunk):
        return first_chunk

    sem = asyncio.Semaphore(8)

    async def get_part(s: int, e: int) -> bytes:
        async with sem:
            r = await _fetch_range_with_retry(url, headers, s, e)
            if r.status_code not in (200, 206):
                raise HTTPException(
                    status_code=502,
                    detail=f"Chunk {s}-{e} failed with status {r.status_code}",
                )
            return r.content

    tasks = []
    pos = len(first_chunk)
    while pos < total_size:
        end = min(pos + STREAM_CHUNK_WINDOW - 1, total_size - 1)
        tasks.append(get_part(pos, end))
        pos = end + 1

    rest_chunks = await asyncio.gather(*tasks)
    return b"".join([first_chunk, *rest_chunks])


def _sync_ffmpeg_mux(v_bytes: bytes, a_bytes: bytes, out_path: str):
    if not FFMPEG_EXE:
        raise RuntimeError("FFmpeg binary is not available")
    tmp_dir = tempfile.mkdtemp(prefix="sd_mux_")
    try:
        v_path = os.path.join(tmp_dir, "video.mp4")
        a_path = os.path.join(tmp_dir, "audio.m4a")
        tmp_out = out_path + f".{os.getpid()}.{int(time.time()*1000)}.tmp.mp4"
        with open(v_path, "wb") as f:
            f.write(v_bytes)
        with open(a_path, "wb") as f:
            f.write(a_bytes)

        cmd = [
            FFMPEG_EXE,
            "-y",
            "-i",
            v_path,
            "-i",
            a_path,
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            tmp_out,
        ]
        # Try ultra-fast stream copy for both video and audio first
        cmd_copy = [
            FFMPEG_EXE,
            "-y",
            "-i",
            v_path,
            "-i",
            a_path,
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            tmp_out,
        ]
        res = subprocess.run(
            cmd_copy, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False
        )
        if res.returncode != 0 or not os.path.exists(tmp_out) or os.path.getsize(tmp_out) < 1024:
            res2 = subprocess.run(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False
            )
            if res2.returncode != 0:
                err_txt = res2.stderr.decode("utf-8", errors="ignore")[-400:]
                raise RuntimeError(f"FFmpeg mux failed: {err_txt}")

        os.replace(tmp_out, out_path)
        _cleanup_mux_cache()
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


async def get_or_create_muxed_mp4(video_id: str, v_itag: str, a_itag: str) -> str:
    safe_vid = re.sub(r"[^A-Za-z0-9_-]", "", video_id)
    safe_v = re.sub(r"[^0-9A-Za-z_-]", "", v_itag)
    safe_a = re.sub(r"[^0-9A-Za-z_-]", "", a_itag)
    cache_key = f"{safe_vid}_mux_{safe_v}_{safe_a}"
    out_path = os.path.join(MUX_CACHE_DIR, f"{cache_key}.mp4")

    if os.path.exists(out_path) and os.path.getsize(out_path) > 1024:
        return out_path

    lock = MUX_LOCKS.setdefault(cache_key, asyncio.Lock())
    async with lock:
        if os.path.exists(out_path) and os.path.getsize(out_path) > 1024:
            return out_path

        v_bytes, a_bytes = await asyncio.gather(
            fetch_full_stream_bytes(video_id, v_itag),
            fetch_full_stream_bytes(video_id, a_itag),
        )
        await asyncio.to_thread(_sync_ffmpeg_mux, v_bytes, a_bytes, out_path)
        return out_path


async def get_or_create_raw_cached_file(video_id: str, itag: str, ext: str) -> str:
    safe_vid = re.sub(r"[^A-Za-z0-9_-]", "", video_id)
    safe_itag = re.sub(r"[^0-9A-Za-z_-]", "", itag)
    cache_key = f"{safe_vid}_raw_{safe_itag}"
    out_path = os.path.join(MUX_CACHE_DIR, f"{cache_key}.{ext}")

    if os.path.exists(out_path) and os.path.getsize(out_path) > 512:
        return out_path

    lock = MUX_LOCKS.setdefault(cache_key, asyncio.Lock())
    async with lock:
        if os.path.exists(out_path) and os.path.getsize(out_path) > 512:
            return out_path

        raw_bytes = await fetch_full_stream_bytes(video_id, itag)
        tmp_out = out_path + f".{os.getpid()}.tmp"
        with open(tmp_out, "wb") as f:
            f.write(raw_bytes)
        os.replace(tmp_out, out_path)
        _cleanup_mux_cache()
        return out_path


@app.get("/api/suggest")
async def search_suggest(q: str = Query("", min_length=1)):
    try:
        resp = await http_client.get(
            "https://suggestqueries.google.com/complete/search",
            params={"client": "firefox", "ds": "yt", "hl": "ja", "q": q},
            timeout=5.0,
        )
        if resp.status_code == 200:
            data = resp.json()
            if isinstance(data, list) and len(data) > 1 and isinstance(data[1], list):
                return {"suggestions": data[1][:8]}
    except Exception:
        pass
    return {"suggestions": []}


@app.get("/api/search")
async def search_videos(q: str = Query(..., min_length=1), limit: int = Query(16, ge=1, le=30)):
    q_clean = q.strip()
    direct_id = extract_video_id(q_clean)
    if direct_id and ("youtube.com" in q_clean or "youtu.be" in q_clean or len(q_clean) == 11):
        try:
            vdata = await get_cached_video(direct_id)
            return {
                "directVideoId": direct_id,
                "results": [
                    {
                        "id": vdata["id"],
                        "title": vdata["title"],
                        "channel": vdata["channel"],
                        "channelId": vdata["channelId"],
                        "duration": vdata["duration"],
                        "viewCount": vdata["viewCount"],
                        "thumbnail": f"/api/thumb/{direct_id}?q=hq",
                    }
                ],
            }
        except Exception:
            pass

    cache_key = f"{q_clean.lower()}::{limit}"
    now = time.time()
    cached = SEARCH_CACHE.get(cache_key)
    if cached and (now - cached["ts"]) < SEARCH_CACHE_TTL:
        return {"directVideoId": None, "results": cached["results"]}

    try:
        results = await asyncio.to_thread(_sync_search, q_clean, limit)
        SEARCH_CACHE[cache_key] = {"ts": now, "results": results}
        return {"directVideoId": None, "results": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"検索エラー: {str(e)}")


@app.get("/api/trending")
async def get_trending(category: str = Query("trending")):
    query = CATEGORY_QUERIES.get(category, CATEGORY_QUERIES["trending"])
    cache_key = f"cat::{category}"
    now = time.time()
    cached = SEARCH_CACHE.get(cache_key)
    if cached and (now - cached["ts"]) < SEARCH_CACHE_TTL:
        return {"category": category, "results": cached["results"]}

    try:
        results = await asyncio.to_thread(_sync_search, query, 16)
        SEARCH_CACHE[cache_key] = {"ts": now, "results": results}
        return {"category": category, "results": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"フィード取得エラー: {str(e)}")


@app.get("/api/video/{video_id}")
async def get_video_info(video_id: str):
    vid = extract_video_id(video_id) or video_id
    try:
        data = await get_cached_video(vid)
        public_data = {
            k: v for k, v in data.items() if not k.startswith("_internal")
        }
        return public_data
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"動画情報の取得に失敗しました: {str(e)}")


@app.get("/api/related/{video_id}")
async def get_related_videos(video_id: str, q: str = Query("")):
    search_term = q.strip()
    if not search_term:
        cached = VIDEO_CACHE.get(video_id)
        if cached:
            search_term = f"{cached.get('channel', '')} {cached.get('title', '')[:25]}"
        else:
            search_term = "人気 動画 おすすめ"

    cache_key = f"rel::{video_id}::{search_term[:30]}"
    now = time.time()
    cached_rel = SEARCH_CACHE.get(cache_key)
    if cached_rel and (now - cached_rel["ts"]) < SEARCH_CACHE_TTL:
        return {"results": cached_rel["results"]}

    try:
        results = await asyncio.to_thread(_sync_search, search_term, 12)
        filtered = [r for r in results if r["id"] != video_id][:10]
        SEARCH_CACHE[cache_key] = {"ts": now, "results": filtered}
        return {"results": filtered}
    except Exception:
        return {"results": []}


@app.get("/api/comments/{video_id}")
async def get_video_comments(video_id: str):
    now = time.time()
    cached = COMMENTS_CACHE.get(video_id)
    if cached and (now - cached["ts"]) < COMMENTS_CACHE_TTL:
        return {"comments": cached["comments"]}

    try:
        comments = await asyncio.to_thread(_sync_extract_comments, video_id, 25)
        COMMENTS_CACHE[video_id] = {"ts": now, "comments": comments}
        return {"comments": comments}
    except Exception as e:
        return {"comments": [], "error": str(e)}


def parse_range_header(range_header: Optional[str]) -> tuple[int, Optional[int]]:
    if not range_header or not range_header.startswith("bytes="):
        return 0, None
    try:
        spec = range_header.split("=", 1)[1].split(",")[0].strip()
        start_str, end_str = spec.split("-", 1)
        start = int(start_str) if start_str else 0
        end = int(end_str) if end_str else None
        return max(0, start), end
    except Exception:
        return 0, None


@app.get("/api/stream/{video_id}")
async def proxy_stream(
    video_id: str,
    request: Request,
    itag: str = Query("mux_136_140"),
    download: int = Query(0),
):
    try:
        data = await get_cached_video(video_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"ストリーム抽出失敗: {str(e)}")

    streams = data.get("_internal_streams") or {}
    safe_title = re.sub(r'[\\/*?:"<>|]', "_", data.get("title", video_id))[:60]

    # 1. Server-side FFmpeg Muxed Stream (mux_{v_itag}_{a_itag})
    if itag.startswith("mux_"):
        parts = itag.split("_")
        v_itag = parts[1] if len(parts) > 1 else "136"
        a_itag = parts[2] if len(parts) > 2 else "140"
        if v_itag not in streams:
            for fb_v in ("136", "135", "134", "137", "133"):
                if fb_v in streams:
                    v_itag = fb_v
                    break
        if a_itag not in streams:
            for fb_a in ("140", "139", "251"):
                if fb_a in streams:
                    a_itag = fb_a
                    break

        if FFMPEG_EXE and v_itag in streams and a_itag in streams:
            muxed_path = await get_or_create_muxed_mp4(video_id, v_itag, a_itag)
            headers = {"Cache-Control": "public, max-age=3600"}
            if download == 1:
                encoded_filename = urllib.parse.quote(f"{safe_title}.mp4")
                headers["Content-Disposition"] = (
                    f"attachment; filename=\"{video_id}.mp4\"; filename*=UTF-8''{encoded_filename}"
                )
            return FileResponse(muxed_path, media_type="video/mp4", headers=headers)
        else:
            itag = v_itag

    # 2. Single Stream (e.g., Audio-Only mode itag=140, or fallback)
    # Avoid broken c=ANDROID itag=18 if 134+140 mux is available
    if itag == "18" and FFMPEG_EXE and "134" in streams and "140" in streams:
        muxed_path = await get_or_create_muxed_mp4(video_id, "134", "140")
        headers = {"Cache-Control": "public, max-age=3600"}
        if download == 1:
            encoded_filename = urllib.parse.quote(f"{safe_title}.mp4")
            headers["Content-Disposition"] = (
                f"attachment; filename=\"{video_id}.mp4\"; filename*=UTF-8''{encoded_filename}"
            )
        return FileResponse(muxed_path, media_type="video/mp4", headers=headers)

    stream_info = streams.get(itag)
    if not stream_info:
        for fallback_itag in ("140", "251", "136", "135", "134"):
            if fallback_itag in streams:
                stream_info = streams[fallback_itag]
                itag = fallback_itag
                break
    if not stream_info:
        raise HTTPException(status_code=404, detail="対応するストリームが見つかりません")

    mime_type = stream_info.get("mime", "video/mp4")
    ext = "m4a" if itag in ("140", "139") else stream_info.get("ext", "mp4")
    known_size = int(stream_info.get("filesize") or 0)

    # For audio streams or downloads (<= 50MB), cache the complete file on disk and serve via FileResponse
    if download == 1 or itag in ("140", "139", "251", "250") or (0 < known_size <= 50 * 1024 * 1024):
        raw_path = await get_or_create_raw_cached_file(video_id, itag, ext)
        headers = {"Cache-Control": "public, max-age=3600"}
        if download == 1:
            encoded_filename = urllib.parse.quote(f"{safe_title}.{ext}")
            headers["Content-Disposition"] = (
                f"attachment; filename=\"{video_id}.{ext}\"; filename*=UTF-8''{encoded_filename}"
            )
        return FileResponse(raw_path, media_type=mime_type, headers=headers)

    # Fallback for very large uncached single streams: return exact in-memory bounded chunk (never mismatches Content-Length)
    target_url = stream_info["url"]
    base_headers = dict(stream_info.get("headers") or {})
    client_range = request.headers.get("range")
    start, client_end = parse_range_header(client_range)

    req_end = start + STREAM_CHUNK_WINDOW - 1
    if client_end is not None and client_end < req_end:
        req_end = client_end
    if known_size > 0 and req_end >= known_size:
        req_end = known_size - 1

    resp = await _fetch_range_with_retry(target_url, base_headers, start, req_end)
    chunk_bytes = resp.content
    resp_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
        "Content-Length": str(len(chunk_bytes)),
    }
    if "content-range" in resp.headers:
        resp_headers["Content-Range"] = resp.headers["content-range"]

    return Response(
        content=chunk_bytes,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type", mime_type),
        headers=resp_headers,
    )


@app.get("/api/subtitles/{video_id}")
async def proxy_subtitles(video_id: str, lang: str = Query("ja")):
    data = await get_cached_video(video_id)
    subs = data.get("_internal_subtitles") or {}
    sub_info = subs.get(lang)
    if not sub_info or not sub_info.get("vtt_url"):
        raise HTTPException(status_code=404, detail="字幕が見つかりません")

    resp = await http_client.get(sub_info["vtt_url"])
    return Response(
        content=resp.content,
        media_type="text/vtt; charset=utf-8",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@app.get("/api/thumb/{video_id}")
async def proxy_thumbnail(video_id: str, q: str = Query("hq")):
    vid = extract_video_id(video_id) or video_id
    cache_key = f"{vid}:{q}"
    if cache_key in THUMB_CACHE:
        return Response(
            content=THUMB_CACHE[cache_key],
            media_type="image/jpeg",
            headers={"Cache-Control": "public, max-age=86400"},
        )

    quality_map = {
        "maxres": ["maxresdefault.jpg", "hqdefault.jpg", "mqdefault.jpg"],
        "hq": ["hqdefault.jpg", "mqdefault.jpg"],
        "mq": ["mqdefault.jpg"],
    }
    candidates = quality_map.get(q, ["hqdefault.jpg"])

    for filename in candidates:
        url = f"https://i.ytimg.com/vi/{vid}/{filename}"
        try:
            resp = await http_client.get(url, timeout=8.0)
            if resp.status_code == 200 and len(resp.content) > 1000:
                if len(THUMB_CACHE) < 300:
                    THUMB_CACHE[cache_key] = resp.content
                return Response(
                    content=resp.content,
                    media_type="image/jpeg",
                    headers={"Cache-Control": "public, max-age=86400"},
                )
        except Exception:
            continue

    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270">'
        '<rect width="480" height="270" fill="#1e293b"/>'
        '<polygon points="215,105 215,165 270,135" fill="#64748b"/>'
        "</svg>"
    )
    return Response(content=svg, media_type="image/svg+xml")


@app.get("/api/avatar")
async def proxy_avatar(url: str = Query(...)):
    if not url.startswith("https://"):
        raise HTTPException(status_code=400, detail="Invalid URL")
    try:
        resp = await http_client.get(url, timeout=6.0)
        if resp.status_code == 200:
            return Response(
                content=resp.content,
                media_type=resp.headers.get("content-type", "image/jpeg"),
                headers={"Cache-Control": "public, max-age=86400"},
            )
    except Exception:
        pass
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">'
        '<rect width="48" height="48" rx="24" fill="#334155"/>'
        '<circle cx="24" cy="18" r="8" fill="#94a3b8"/>'
        '<path d="M10 42c2-9 26-9 28 0" fill="#94a3b8"/>'
        "</svg>"
    )
    return Response(content=svg, media_type="image/svg+xml")


@app.api_route("/api/health", methods=["GET", "HEAD"])
async def health_check():
    return {
        "status": "ok",
        "uptimeSeconds": int(time.time() - SERVER_START_TIME),
        "ffmpegReady": bool(FFMPEG_EXE),
        "cookiesActive": bool(get_active_cookiefile()),
        "ytDlpVersion": yt_dlp.version.__version__,
    }


@app.get("/api/cookies")
async def get_cookies_status():
    cfile = get_active_cookiefile()
    size = os.path.getsize(cfile) if cfile else 0
    return {"active": bool(cfile), "bytes": size}


@app.post("/api/cookies")
async def save_cookies(request: Request):
    body = await request.json()
    content = str(body.get("cookies") or "").strip()
    if not content:
        if os.path.exists(COOKIES_FILE_PATH):
            os.remove(COOKIES_FILE_PATH)
        VIDEO_CACHE.clear()
        return {"active": False, "bytes": 0}
    if "# Netscape HTTP Cookie File" not in content:
        content = "# Netscape HTTP Cookie File\n" + content
    with open(COOKIES_FILE_PATH, "w", encoding="utf-8") as f:
        f.write(content + "\n")
    VIDEO_CACHE.clear()
    return {"active": True, "bytes": os.path.getsize(COOKIES_FILE_PATH)}


@app.on_event("startup")
async def start_self_keepalive():
    # Automatically keep cloud container awake if SPACE_HOST (Hugging Face) or RENDER_EXTERNAL_URL is set
    ext_url = os.environ.get("RENDER_EXTERNAL_URL") or os.environ.get("PUBLIC_URL") or ""
    if not ext_url and os.environ.get("SPACE_HOST"):
        ext_url = f"https://{os.environ['SPACE_HOST']}"
    if ext_url:
        ping_target = ext_url.rstrip("/") + "/api/health"

        async def _ping_loop():
            while True:
                await asyncio.sleep(540)  # Every 9 minutes
                try:
                    await http_client.get(ping_target, timeout=10.0)
                except Exception:
                    pass

        asyncio.create_task(_ping_loop())


app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def index():
    return FileResponse("static/index.html")
