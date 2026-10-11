(() => {
  "use strict";

  // =========================================================================
  // State & Configuration
  // =========================================================================
  const STORAGE_KEYS = {
    FAVORITES: "sd_favorites_v1",
    HISTORY: "sd_history_v1",
    NOTES: "sd_notes_v1",
    SETTINGS: "sd_settings_v1",
  };

  const CLOAK_PRESETS = {
    gdocs: {
      title: "無題のドキュメント - Google ドキュメント",
      icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Cpath fill='%232196f3' d='M37,45H11c-1.657,0-3-1.343-3-3V6c0-1.657,1.343-3,3-3h19l10,10v29C40,43.657,38.657,45,37,45z'/%3E%3Cpath fill='%23bbdefb' d='M40 13L30 13 30 3z'/%3E%3Cpath fill='%23fff' d='M15 23H33V25H15zM15 28H33V30H15zM15 33H27V35H15z'/%3E%3C/svg%3E",
    },
    gsheets: {
      title: "課題集計データ_2026.xlsx - Google スプレッドシート",
      icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Cpath fill='%230f9d58' d='M37,45H11c-1.657,0-3-1.343-3-3V6c0-1.657,1.343-3,3-3h19l10,10v29C40,43.657,38.657,45,37,45z'/%3E%3Cpath fill='%23fff' d='M15 21H33V35H15z'/%3E%3C/svg%3E",
    },
    classroom: {
      title: "ホーム - Classroom",
      icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Crect width='48' height='48' rx='8' fill='%231e8e3e'/%3E%3Crect x='6' y='8' width='36' height='28' rx='2' fill='%23fff'/%3E%3Crect x='8' y='10' width='32' height='24' fill='%231e8e3e'/%3E%3C/svg%3E",
    },
    wikipedia: {
      title: "日本史の年表 - Wikipedia",
      icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Ccircle cx='24' cy='24' r='22' fill='%23f5f5f5' stroke='%23999' stroke-width='2'/%3E%3Ctext x='11' y='32' font-family='serif' font-size='26' font-weight='bold' fill='%23111'%3EW%3C/text%3E%3C/svg%3E",
    },
    notion: {
      title: "総合探究レポートまとめ — Notion",
      icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Crect width='44' height='44' x='2' y='2' rx='8' fill='%23fff' stroke='%23111' stroke-width='3'/%3E%3Ctext x='13' y='34' font-family='sans-serif' font-size='28' font-weight='bold' fill='%23111'%3EN%3C/text%3E%3C/svg%3E",
    },
  };

  let state = {
    currentVideo: null,
    currentMode: "proxy", // 'proxy' | 'audio' | 'nocookie' | 'mirror'
    currentQualityId: "720p_dash",
    currentSpeed: 1.0,
    currentSubtitle: "off",
    screenSize: "100",
    loop: false,
    useExternalMirrorIframe: false,
    volume: 1.0,
    muted: false,
    activeCategory: "trending",
    panicActive: false,
    wasPlayingBeforePanic: false,
    relatedVideos: [],
    favorites: loadJson(STORAGE_KEYS.FAVORITES, []),
    history: loadJson(STORAGE_KEYS.HISTORY, []),
    notes: loadJson(STORAGE_KEYS.NOTES, {}),
    settings: Object.assign(
      {
        cloakPreset: "gdocs",
        customTitle: "",
        panicKey: "Escape",
        panicAudio: "pause", // 'pause' | 'keep'
        autoPanicBlur: false,
        mirrorUrl: "https://inv.nadeko.net",
        themeDoc: false,
      },
      loadJson(STORAGE_KEYS.SETTINGS, {})
    ),
  };

  // Active media element references for cleanup & sync
  let activeVideoEl = null;
  let activeAudioEl = null;
  let audioCleanupFns = [];

  // Persistent pre-unlocked Audio element so browser Autoplay Policy never blocks audio after async fetch
  const sharedAudioEl = document.createElement("audio");
  sharedAudioEl.preload = "auto";
  sharedAudioEl.style.display = "none";
  document.body.appendChild(sharedAudioEl);

  const SILENT_WAV =
    "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

  function unlockSharedAudio() {
    try {
      sharedAudioEl.muted = false;
      sharedAudioEl.volume = state.muted ? 0 : state.volume;
      if (!sharedAudioEl.src || sharedAudioEl.paused) {
        sharedAudioEl.src = SILENT_WAV;
        const p = sharedAudioEl.play();
        if (p && typeof p.then === "function") {
          p.then(() => {
            sharedAudioEl.pause();
          }).catch(() => {});
        }
      }
    } catch (_) {}
  }

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {}
  }

  // =========================================================================
  // DOM Elements
  // =========================================================================
  const el = {
    homeLogoBtn: document.getElementById("home-logo-btn"),
    searchForm: document.getElementById("search-form"),
    searchInput: document.getElementById("search-input"),
    searchClearBtn: document.getElementById("search-clear-btn"),
    suggestDropdown: document.getElementById("suggest-dropdown"),
    aboutBlankBtn: document.getElementById("about-blank-btn"),
    themeToggleBtn: document.getElementById("theme-toggle-btn"),
    stealthSettingsBtn: document.getElementById("stealth-settings-btn"),
    panicTriggerBtn: document.getElementById("panic-trigger-btn"),
    categoryTabs: document.getElementById("category-tabs"),
    favCount: document.getElementById("fav-count"),
    connectionIndicator: document.getElementById("connection-mode-indicator"),

    watchSection: document.getElementById("watch-section"),
    playbackModeTabs: document.getElementById("playback-mode-tabs"),
    closePlayerBtn: document.getElementById("close-player-btn"),
    playerStageWrapper: document.getElementById("player-stage-wrapper"),
    playerAspectBox: document.getElementById("player-aspect-box"),

    qualitySelect: document.getElementById("quality-select"),
    speedSelect: document.getElementById("speed-select"),
    subtitleSelect: document.getElementById("subtitle-select"),
    screenSizeSelect: document.getElementById("screen-size-select"),
    muteToggleBtn: document.getElementById("mute-toggle-btn"),
    volumeSlider: document.getElementById("volume-slider"),
    loopToggleBtn: document.getElementById("loop-toggle-btn"),
    pipBtn: document.getElementById("pip-btn"),
    downloadVideoBtn: document.getElementById("download-video-btn"),
    downloadAudioBtn: document.getElementById("download-audio-btn"),

    videoTitle: document.getElementById("video-title"),
    videoChannel: document.getElementById("video-channel"),
    channelSearchBtn: document.getElementById("channel-search-btn"),
    favoriteToggleBtn: document.getElementById("favorite-toggle-btn"),
    copyIdBtn: document.getElementById("copy-id-btn"),
    videoViews: document.getElementById("video-views"),
    videoLikes: document.getElementById("video-likes"),
    videoDate: document.getElementById("video-date"),
    chaptersStrip: document.getElementById("chapters-strip"),

    videoDescription: document.getElementById("video-description"),
    videoComments: document.getElementById("video-comments"),
    commentCountBadge: document.getElementById("comment-count-badge"),
    videoNotesBox: document.getElementById("video-notes-box"),
    studyNotesTextarea: document.getElementById("study-notes-textarea"),
    insertTimestampBtn: document.getElementById("insert-timestamp-btn"),

    relatedList: document.getElementById("related-list"),
    autoplayNextCheckbox: document.getElementById("autoplay-next-checkbox"),

    feedHeading: document.getElementById("feed-heading"),
    feedExtraActions: document.getElementById("feed-extra-actions"),
    videoGrid: document.getElementById("video-grid"),

    stealthModal: document.getElementById("stealth-modal"),
    closeStealthModalBtn: document.getElementById("close-stealth-modal-btn"),
    cloakPresets: document.getElementById("cloak-presets"),
    customTabTitle: document.getElementById("custom-tab-title"),
    applyCustomTitleBtn: document.getElementById("apply-custom-title-btn"),
    panicKeySelect: document.getElementById("panic-key-select"),
    panicAudioSelect: document.getElementById("panic-audio-select"),
    autoPanicBlurCheckbox: document.getElementById("auto-panic-blur-checkbox"),
    customMirrorInput: document.getElementById("custom-mirror-input"),
    wipeAllDataBtn: document.getElementById("wipe-all-data-btn"),

    panicOverlay: document.getElementById("panic-overlay"),
    panicReturnBtn: document.getElementById("panic-return-btn"),
    panicBgmIndicator: document.getElementById("panic-bgm-indicator"),
  };

  // =========================================================================
  // Utility Helpers
  // =========================================================================
  function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return "LIVE / --:--";
    const s = Math.floor(seconds);
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    if (hrs > 0) {
      return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    }
    return `${mins}:${String(secs).padStart(2, "0")}`;
  }

  function formatNumber(num) {
    if (!num || num <= 0) return "-";
    if (num >= 100000000) return (num / 100000000).toFixed(1) + "億";
    if (num >= 10000) return (num / 10000).toFixed(1) + "万";
    return num.toLocaleString("ja-JP");
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatDescriptionWithTimestamps(desc) {
    const safe = escapeHtml(desc);
    // Replace MM:SS or HH:MM:SS with clickable seek links
    return safe.replace(/\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g, (match, h, m, s) => {
      const totalSeconds = (parseInt(h || "0", 10) * 3600) + (parseInt(m, 10) * 60) + parseInt(s, 10);
      return `<span class="ts-link" data-seek="${totalSeconds}">⏱️ ${match}</span>`;
    });
  }

  function updateFavCount() {
    el.favCount.textContent = state.favorites.length;
  }

  // =========================================================================
  // Stealth, Cloak & Theme Functions
  // =========================================================================
  function applySettingsToUI() {
    // Theme
    if (state.settings.themeDoc) {
      document.body.classList.add("theme-doc");
      el.themeToggleBtn.textContent = "🌙 ダークUI切替";
    } else {
      document.body.classList.remove("theme-doc");
      el.themeToggleBtn.textContent = "📄 資料風UI切替";
    }

    // Tab Cloak
    const preset = CLOAK_PRESETS[state.settings.cloakPreset] || CLOAK_PRESETS.gdocs;
    document.title = state.settings.customTitle || preset.title;
    const favLink = document.getElementById("dynamic-favicon");
    if (favLink) favLink.href = preset.icon;

    // Highlight active preset button
    el.cloakPresets.querySelectorAll(".preset-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.preset === state.settings.cloakPreset);
    });

    el.customTabTitle.value = state.settings.customTitle || "";
    el.panicKeySelect.value = state.settings.panicKey || "Escape";
    el.panicAudioSelect.value = state.settings.panicAudio || "pause";
    el.autoPanicBlurCheckbox.checked = !!state.settings.autoPanicBlur;
    el.customMirrorInput.value = state.settings.mirrorUrl || "https://inv.nadeko.net";
  }

  function togglePanicScreen(forceState) {
    const nextState = typeof forceState === "boolean" ? forceState : !state.panicActive;
    state.panicActive = nextState;

    if (state.panicActive) {
      el.panicOverlay.classList.add("active");
      if (state.settings.panicAudio === "pause") {
        // Pause all media
        if (activeVideoEl && !activeVideoEl.paused) {
          state.wasPlayingBeforePanic = true;
          activeVideoEl.pause();
        }
        if (activeAudioEl && !activeAudioEl.paused) {
          state.wasPlayingBeforePanic = true;
          activeAudioEl.pause();
        }
        // If iframe mode is active, temporarily blank it to silence audio
        const iframe = el.playerAspectBox.querySelector("iframe");
        if (iframe && iframe.src) {
          iframe.dataset.savedSrc = iframe.src;
          iframe.src = "about:blank";
        }
        el.panicBgmIndicator.textContent = "ステータス: オフライン保存済み (Escまたはクリックで復帰)";
      } else {
        el.panicBgmIndicator.textContent = "ステータス: 音声バックグラウンド再生中 • (Escまたはクリックで復帰)";
      }
    } else {
      el.panicOverlay.classList.remove("active");
      const iframe = el.playerAspectBox.querySelector("iframe");
      if (iframe && iframe.dataset.savedSrc) {
        iframe.src = iframe.dataset.savedSrc;
        delete iframe.dataset.savedSrc;
      }
      if (state.wasPlayingBeforePanic) {
        state.wasPlayingBeforePanic = false;
        if (activeVideoEl) activeVideoEl.play().catch(() => {});
        if (activeAudioEl) activeAudioEl.play().catch(() => {});
      }
    }
  }

  function launchAboutBlankCloak() {
    const win = window.open("about:blank", "_blank");
    if (!win) {
      alert("ポップアップがブロックされました。ブラウザのアドレスバー右端からポップアップを許可してください。");
      return;
    }
    const preset = CLOAK_PRESETS[state.settings.cloakPreset] || CLOAK_PRESETS.gdocs;
    const title = escapeHtml(state.settings.customTitle || preset.title);
    const icon = preset.icon;
    const targetUrl = window.location.href;

    win.document.open();
    win.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <link rel="icon" type="image/svg+xml" href="${icon}">
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #0f172a; }
    iframe { width: 100%; height: 100%; border: none; display: block; }
  </style>
</head>
<body>
  <iframe src="${targetUrl}" allow="autoplay; fullscreen; picture-in-picture"></iframe>
</body>
</html>`);
    win.document.close();
  }

  // =========================================================================
  // Feed & Search Loading
  // =========================================================================
  async function loadCategoryFeed(category) {
    state.activeCategory = category;
    el.categoryTabs.querySelectorAll(".cat-pill").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.cat === category);
    });
    el.feedExtraActions.innerHTML = "";

    const titles = {
      trending: "🔥 急上昇・話題の動画",
      music: "🎵 音楽・公式MV",
      gaming: "🎮 ゲーム・実況トレンド",
      study: "📚 学習・わかりやすい授業解説",
      tech: "💻 テクノロジー・ガジェット解説",
      comedy: "😂 お笑い・公式漫才・エンタメ",
      bgm: "🎧 勉強・作業用BGM (Lo-fi / Chill)",
      favorites: "⭐ お気に入り保存した動画",
      history: "🕒 最近の再生履歴（このブラウザのみ保存）",
    };
    el.feedHeading.textContent = titles[category] || "動画一覧";

    if (category === "favorites") {
      renderVideoGrid(state.favorites, "お気に入りに登録された動画はまだありません。動画再生画面の「☆ お気に入り追加」から保存できます。");
      return;
    }

    if (category === "history") {
      if (state.history.length > 0) {
        const clearBtn = document.createElement("button");
        clearBtn.className = "btn btn-sm";
        clearBtn.textContent = "🗑️ 再生履歴を消去";
        clearBtn.onclick = () => {
          state.history = [];
          saveJson(STORAGE_KEYS.HISTORY, []);
          loadCategoryFeed("history");
        };
        el.feedExtraActions.appendChild(clearBtn);
      }
      renderVideoGrid(state.history, "再生履歴はありません。");
      return;
    }

    el.videoGrid.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <p>「${escapeHtml(el.feedHeading.textContent)}」をサーバー経由で取得しています...</p>
      </div>
    `;

    try {
      const resp = await fetch(`/api/trending?category=${encodeURIComponent(category)}`);
      if (!resp.ok) throw new Error("フィードの取得に失敗しました");
      const data = await resp.json();
      renderVideoGrid(data.results || [], "動画が見つかりませんでした。");
    } catch (err) {
      el.videoGrid.innerHTML = `
        <div class="loading-state">
          <p>⚠️ 読み込みエラー: ${escapeHtml(err.message)}</p>
          <button class="btn btn-accent" onclick="location.reload()">再読み込み</button>
        </div>
      `;
    }
  }

  async function executeSearch(query) {
    const q = query.trim();
    if (!q) return;
    el.suggestDropdown.classList.remove("open");

    el.categoryTabs.querySelectorAll(".cat-pill").forEach((btn) => btn.classList.remove("active"));
    el.feedHeading.textContent = `🔍 「${q}」の検索結果`;
    el.feedExtraActions.innerHTML = "";

    el.videoGrid.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <p>「${escapeHtml(q)}」をサーバー経由で検索中...</p>
      </div>
    `;

    try {
      const resp = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=16`);
      if (!resp.ok) throw new Error("検索リクエストに失敗しました");
      const data = await resp.json();

      if (data.directVideoId) {
        openVideo(data.directVideoId);
      }
      renderVideoGrid(data.results || [], "一致する動画が見つかりませんでした。別のキーワードやURLをお試しください。");
    } catch (err) {
      el.videoGrid.innerHTML = `
        <div class="loading-state">
          <p>⚠️ 検索エラー: ${escapeHtml(err.message)}</p>
        </div>
      `;
    }
  }

  function renderVideoGrid(items, emptyMessage) {
    if (!items || items.length === 0) {
      el.videoGrid.innerHTML = `
        <div class="loading-state">
          <p>${escapeHtml(emptyMessage)}</p>
        </div>
      `;
      return;
    }

    el.videoGrid.innerHTML = items
      .map(
        (v) => `
      <article class="video-card" data-vid="${escapeHtml(v.id)}">
        <div class="card-thumb-wrap">
          <img src="${escapeHtml(v.thumbnail || `/api/thumb/${v.id}?q=hq`)}" alt="${escapeHtml(v.title)}" loading="lazy" />
          <span class="duration-badge">${formatDuration(v.duration)}</span>
        </div>
        <div class="card-body">
          <h3 class="card-title" title="${escapeHtml(v.title)}">${escapeHtml(v.title)}</h3>
          <div class="card-footer">
            <span class="card-channel" data-channel="${escapeHtml(v.channel)}" title="このチャンネルを検索">📺 ${escapeHtml(v.channel)}</span>
            <span>${v.viewCount ? formatNumber(v.viewCount) + "回視聴" : ""}</span>
          </div>
        </div>
      </article>
    `
      )
      .join("");

    el.videoGrid.querySelectorAll(".video-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        const chEl = e.target.closest(".card-channel");
        if (chEl && chEl.dataset.channel) {
          e.stopPropagation();
          el.searchInput.value = chEl.dataset.channel;
          executeSearch(chEl.dataset.channel);
          return;
        }
        openVideo(card.dataset.vid);
      });
    });
  }

  // =========================================================================
  // Video Playback & Multi-Mode Engine
  // =========================================================================
  function cleanupMediaElements() {
    audioCleanupFns.forEach((fn) => {
      try {
        fn();
      } catch (_) {}
    });
    audioCleanupFns = [];

    if (activeVideoEl) {
      activeVideoEl.pause();
      activeVideoEl.removeAttribute("src");
      activeVideoEl.load();
      activeVideoEl = null;
    }
    if (activeAudioEl) {
      activeAudioEl.pause();
      if (activeAudioEl !== sharedAudioEl) {
        activeAudioEl.removeAttribute("src");
        activeAudioEl.load();
      } else {
        sharedAudioEl.removeAttribute("src");
      }
      activeAudioEl = null;
    }
    el.playerAspectBox.innerHTML = "";
  }

  async function openVideo(videoId) {
    if (!videoId) return;
    // Unlock persistent audio element synchronously inside user click gesture BEFORE async fetch!
    unlockSharedAudio();

    el.watchSection.classList.add("active");
    window.scrollTo({ top: 0, behavior: "smooth" });

    cleanupMediaElements();
    el.playerAspectBox.innerHTML = `
      <div class="loading-state" style="height:100%; justify-content:center; color:#cbd5e1;">
        <div class="spinner"></div>
        <p>サーバー経由でストリームを準備しています...</p>
      </div>
    `;
    el.videoTitle.textContent = "動画情報を取得中...";
    el.videoDescription.textContent = "読み込み中...";
    el.videoComments.innerHTML = `<div class="loading-state">コメントを読み込み中...</div>`;
    el.commentCountBadge.textContent = "...";
    el.relatedList.innerHTML = `<div class="loading-state">関連動画を取得中...</div>`;

    try {
      const resp = await fetch(`/api/video/${encodeURIComponent(videoId)}`);
      if (!resp.ok) throw new Error("動画ストリーム情報の抽出に失敗しました");
      const vdata = await resp.json();
      state.currentVideo = vdata;

      // Save to Watch History
      addToHistory(vdata);
      updateFavoriteButtonUI();

      // Populate metadata
      el.videoTitle.textContent = vdata.title;
      el.videoChannel.textContent = vdata.channel;
      el.videoViews.textContent = `👁️ ${formatNumber(vdata.viewCount)} 回視聴`;
      el.videoLikes.textContent = `👍 ${formatNumber(vdata.likeCount)}`;
      el.videoDate.textContent = `📅 ${vdata.uploadDate || "-"}`;
      el.videoDescription.innerHTML = formatDescriptionWithTimestamps(vdata.description || "概要欄はありません。");

      // Bind clickable timestamps inside description
      el.videoDescription.querySelectorAll(".ts-link").forEach((ts) => {
        ts.addEventListener("click", () => {
          seekToSeconds(parseInt(ts.dataset.seek, 10));
        });
      });

      // Populate Chapters if available
      if (vdata.chapters && vdata.chapters.length > 0) {
        el.chaptersStrip.style.display = "flex";
        el.chaptersStrip.innerHTML = vdata.chapters
          .map(
            (ch) =>
              `<button class="chapter-chip" data-start="${Math.floor(ch.start_time)}">⏱️ ${formatDuration(ch.start_time)} ${escapeHtml(ch.title)}</button>`
          )
          .join("");
        el.chaptersStrip.querySelectorAll(".chapter-chip").forEach((chip) => {
          chip.addEventListener("click", () => seekToSeconds(parseInt(chip.dataset.start, 10)));
        });
      } else {
        el.chaptersStrip.style.display = "none";
      }

      // Populate Quality selector
      const qualities = vdata.qualities && vdata.qualities.length > 0
        ? vdata.qualities
        : [{ id: "720p_dash", label: "720p HD (高画質・音声統合)", videoItag: "mux_136_140", audioItag: null }];

      el.qualitySelect.innerHTML = qualities
        .map((q) => `<option value="${escapeHtml(q.id)}">${escapeHtml(q.label)}</option>`)
        .join("");

      if (!qualities.some((q) => q.id === state.currentQualityId)) {
        const pref720 = qualities.find((q) => q.id === "720p_dash");
        state.currentQualityId = pref720 ? pref720.id : qualities[0].id;
      }
      el.qualitySelect.value = state.currentQualityId;

      // Populate Subtitles selector
      const subs = vdata.subtitles || [];
      el.subtitleSelect.innerHTML =
        `<option value="off">字幕オフ</option>` +
        subs.map((s) => `<option value="${escapeHtml(s.lang)}">${escapeHtml(s.label)}</option>`).join("");
      el.subtitleSelect.value = subs.some((s) => s.lang === state.currentSubtitle) ? state.currentSubtitle : "off";

      // Update Download buttons
      const activeQ = qualities.find((q) => q.id === state.currentQualityId) || qualities[0];
      el.downloadVideoBtn.href = `/api/stream/${encodeURIComponent(vdata.id)}?itag=${encodeURIComponent(activeQ.videoItag || "mux_136_140")}&download=1`;
      el.downloadAudioBtn.href = `/api/stream/${encodeURIComponent(vdata.id)}?itag=${encodeURIComponent(vdata.audioItag || "140")}&download=1`;

      // Load per-video study notes
      el.studyNotesTextarea.value = state.notes[vdata.id] || "";

      // Render player for current mode
      renderPlayerStage();

      // Fetch Related Videos & Comments asynchronously
      fetchRelatedVideos(vdata);
      fetchComments(vdata.id);
    } catch (err) {
      el.playerAspectBox.innerHTML = `
        <div class="loading-state" style="height:100%; justify-content:center; color:#f8fafc;">
          <p>⚠️ サーバー抽出エラー: ${escapeHtml(err.message)}</p>
          <div style="display:flex; gap:0.5rem; margin-top:0.5rem;">
            <button class="btn btn-accent" id="fallback-nocookie-btn">🔒 No-Cookie埋め込みモードで開く</button>
          </div>
        </div>
      `;
      const fbBtn = document.getElementById("fallback-nocookie-btn");
      if (fbBtn) {
        fbBtn.onclick = () => {
          state.currentVideo = { id: videoId, title: "YouTube Video (" + videoId + ")" };
          switchPlaybackMode("nocookie");
        };
      }
    }
  }

  function renderPlayerStage(preserveTime = 0) {
    if (!state.currentVideo) return;
    const vid = state.currentVideo.id;
    cleanupMediaElements();

    // Update mode indicator
    const modeNames = {
      proxy: "保護通信: サーバー完全中継 (YouTube通信ゼロ)",
      audio: "保護通信: 音声のみサーバー中継 (省通信・背後対策)",
      nocookie: "再生モード: No-Cookie プライバシー埋め込み",
      mirror: "再生モード: ミラー / 軽量ストリーム中継",
    };
    el.connectionIndicator.textContent = modeNames[state.currentMode] || "";

    el.playbackModeTabs.querySelectorAll(".mode-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === state.currentMode);
    });

    // MODE 1: Server Direct Stream Proxy (Server-side FFmpeg Muxed MP4 or Dual-Stream)
    if (state.currentMode === "proxy") {
      const qualities = state.currentVideo.qualities || [];
      const qObj =
        qualities.find((q) => q.id === state.currentQualityId) ||
        qualities[0] ||
        { videoItag: "mux_136_140", audioItag: null };

      if (el.downloadVideoBtn) {
        el.downloadVideoBtn.href = `/api/stream/${encodeURIComponent(vid)}?itag=${encodeURIComponent(qObj.videoItag)}&download=1`;
      }

      const videoEl = document.createElement("video");
      videoEl.controls = true;
      videoEl.playsInline = true;
      videoEl.preload = "auto";
      videoEl.loop = state.loop;
      videoEl.poster = `/api/thumb/${encodeURIComponent(vid)}?q=maxres`;
      videoEl.playbackRate = state.currentSpeed;
      videoEl.volume = state.muted ? 0 : state.volume;
      videoEl.muted = state.muted;

      // Loading badge shown while server prepares/muxes the HD MP4 stream
      const muxBadge = document.createElement("div");
      muxBadge.style.cssText =
        "position:absolute; top:14px; left:14px; z-index:25; background:rgba(15,23,42,0.85); color:#f8fafc; padding:0.45rem 0.85rem; border-radius:8px; font-size:0.82rem; display:flex; align-items:center; gap:0.5rem; pointer-events:none; border:1px solid rgba(255,255,255,0.15);";
      muxBadge.innerHTML = `<span class="spinner" style="width:14px;height:14px;border-width:2px;"></span><span>高画質ストリーム(映像+音声)を準備中...</span>`;
      el.playerAspectBox.appendChild(muxBadge);

      const hideMuxBadge = () => {
        muxBadge.style.display = "none";
      };
      videoEl.addEventListener("loadeddata", hideMuxBadge);
      videoEl.addEventListener("canplay", hideMuxBadge);
      videoEl.addEventListener("playing", hideMuxBadge);

      // Attach subtitle tracks if available
      const subs = state.currentVideo.subtitles || [];
      subs.forEach((s) => {
        const track = document.createElement("track");
        track.kind = "subtitles";
        track.label = s.label;
        track.srclang = s.lang;
        track.src = s.proxy_url;
        if (state.currentSubtitle === s.lang) {
          track.default = true;
        }
        videoEl.appendChild(track);
      });

      // Floating Audio Unblock button (only shown if browser blocks initial audio autoplay)
      const unmuteOverlay = document.createElement("button");
      unmuteOverlay.className = "btn btn-accent";
      unmuteOverlay.style.cssText =
        "position:absolute; top:14px; right:14px; z-index:30; display:none; box-shadow:0 4px 14px rgba(0,0,0,0.6); font-size:0.86rem; padding:0.5rem 1rem;";
      unmuteOverlay.textContent = "🔊 クリックして音声をONにする";
      el.playerAspectBox.appendChild(unmuteOverlay);

      if (qObj.audioItag) {
        const audioEl = sharedAudioEl;
        activeAudioEl = audioEl;
        audioEl.loop = state.loop;
        audioEl.playbackRate = state.currentSpeed;
        audioEl.volume = state.muted ? 0 : state.volume;
        audioEl.muted = state.muted;

        let videoReady = false;
        let audioReady = false;
        let initialStarted = false;
        let lastSyncTimestamp = 0;

        const tryStartBoth = () => {
          if (initialStarted || !videoReady || !audioReady) return;
          initialStarted = true;
          if (preserveTime > 0) {
            try {
              videoEl.currentTime = preserveTime;
              audioEl.currentTime = preserveTime;
            } catch (_) {}
          }
          videoEl.play().catch(() => {});
          const playPromise = audioEl.play();
          if (playPromise && typeof playPromise.catch === "function") {
            playPromise.catch(() => {
              unmuteOverlay.style.display = "inline-flex";
            });
          }
        };

        unmuteOverlay.onclick = (e) => {
          e.stopPropagation();
          unmuteOverlay.style.display = "none";
          state.muted = false;
          audioEl.muted = false;
          audioEl.volume = state.volume;
          updateVolumeUI();
          audioEl.currentTime = videoEl.currentTime || 0;
          audioEl.play().catch(() => {});
          if (videoEl.paused) videoEl.play().catch(() => {});
        };

        const onVideoLoadedMeta = () => {
          videoEl.playbackRate = state.currentSpeed;
          applySubtitleTrackState(videoEl);
        };
        const onVideoCanPlay = () => {
          videoReady = true;
          tryStartBoth();
        };
        const onAudioCanPlay = () => {
          audioReady = true;
          tryStartBoth();
        };

        const onVideoPlay = () => {
          if (!initialStarted) return;
          if (!audioEl.seeking && audioEl.readyState >= 2) {
            const diff = Math.abs((videoEl.currentTime || 0) - (audioEl.currentTime || 0));
            if (diff > 0.35) {
              try {
                audioEl.currentTime = videoEl.currentTime || 0;
              } catch (_) {}
            }
          }
          audioEl.play().then(() => {
            unmuteOverlay.style.display = "none";
          }).catch(() => {
            unmuteOverlay.style.display = "inline-flex";
          });
        };

        const onVideoPause = () => {
          if (!videoEl.seeking) {
            audioEl.pause();
          }
        };

        const onVideoSeeked = () => {
          if (audioEl.readyState >= 1) {
            try {
              lastSyncTimestamp = Date.now();
              audioEl.currentTime = videoEl.currentTime || 0;
            } catch (_) {}
          }
          if (!videoEl.paused) {
            audioEl.play().catch(() => {});
          }
        };

        const onVideoRateChange = () => {
          audioEl.playbackRate = videoEl.playbackRate || 1.0;
        };

        const onVideoTimeUpdate = () => {
          if (videoEl.paused || videoEl.seeking || audioEl.seeking || audioEl.readyState < 3) {
            return;
          }
          if (audioEl.paused && initialStarted) {
            audioEl.play().then(() => {
              unmuteOverlay.style.display = "none";
            }).catch(() => {
              unmuteOverlay.style.display = "inline-flex";
            });
            return;
          }
          const now = Date.now();
          if (now - lastSyncTimestamp < 2500) {
            return;
          }
          const drift = Math.abs((videoEl.currentTime || 0) - (audioEl.currentTime || 0));
          if (drift > 0.45) {
            lastSyncTimestamp = now;
            try {
              audioEl.currentTime = videoEl.currentTime || 0;
            } catch (_) {}
          }
        };

        videoEl.addEventListener("loadedmetadata", onVideoLoadedMeta);
        videoEl.addEventListener("canplay", onVideoCanPlay);
        videoEl.addEventListener("play", onVideoPlay);
        videoEl.addEventListener("pause", onVideoPause);
        videoEl.addEventListener("seeked", onVideoSeeked);
        videoEl.addEventListener("ratechange", onVideoRateChange);
        videoEl.addEventListener("timeupdate", onVideoTimeUpdate);
        audioEl.addEventListener("canplay", onAudioCanPlay);

        audioCleanupFns.push(() => {
          audioEl.removeEventListener("canplay", onAudioCanPlay);
        });

        audioEl.src = `/api/stream/${encodeURIComponent(vid)}?itag=${encodeURIComponent(qObj.audioItag)}`;
        audioEl.load();
      } else {
        let singleStarted = false;
        unmuteOverlay.onclick = (e) => {
          e.stopPropagation();
          unmuteOverlay.style.display = "none";
          state.muted = false;
          videoEl.muted = false;
          videoEl.volume = state.volume;
          updateVolumeUI();
          videoEl.play().catch(() => {});
        };
        videoEl.addEventListener("loadedmetadata", () => {
          if (preserveTime > 0 && preserveTime < videoEl.duration) {
            try {
              videoEl.currentTime = preserveTime;
            } catch (_) {}
          }
          videoEl.playbackRate = state.currentSpeed;
          applySubtitleTrackState(videoEl);
        });
        videoEl.addEventListener("canplay", () => {
          if (singleStarted) return;
          singleStarted = true;
          const p = videoEl.play();
          if (p && typeof p.catch === "function") {
            p.catch(() => {
              // Browser blocked unmuted autoplay -> start muted and show 1-click unmute button
              videoEl.muted = true;
              unmuteOverlay.style.display = "inline-flex";
              videoEl.play().catch(() => {});
            });
          }
        });
        videoEl.addEventListener("volumechange", () => {
          if (!videoEl.muted && unmuteOverlay.style.display !== "none") {
            unmuteOverlay.style.display = "none";
          }
        });
      }

      videoEl.addEventListener("ended", handleMediaEnded);
      videoEl.src = `/api/stream/${encodeURIComponent(vid)}?itag=${encodeURIComponent(qObj.videoItag)}`;
      activeVideoEl = videoEl;
      el.playerAspectBox.appendChild(videoEl);
      videoEl.load();
      return;
    }

    // MODE 2: Audio-Only / BGM Stealth Mode
    if (state.currentMode === "audio") {
      const audioItag = state.currentVideo.audioItag || "140";
      const stageDiv = document.createElement("div");
      stageDiv.className = "audio-only-stage";
      stageDiv.innerHTML = `
        <div class="audio-stage-header">
          <img class="audio-stage-thumb" src="/api/thumb/${encodeURIComponent(vid)}?q=mq" alt="thumb" />
          <div style="flex:1; min-width:0;">
            <div style="font-size:0.78rem; color:var(--accent); font-weight:700; margin-bottom:2px;">
              🎧 音声のみステルス中継モード (映像非表示・通信量90%削減)
            </div>
            <div style="font-weight:700; font-size:0.98rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              ${escapeHtml(state.currentVideo.title)}
            </div>
            <div style="font-size:0.8rem; color:var(--text-muted);">
              ${escapeHtml(state.currentVideo.channel)}
            </div>
          </div>
          <div class="audio-visualizer-bars">
            <span class="vis-bar"></span>
            <span class="vis-bar"></span>
            <span class="vis-bar"></span>
            <span class="vis-bar"></span>
            <span class="vis-bar"></span>
          </div>
        </div>
        <audio id="bgm-audio-player" controls autoplay preload="auto" style="width:100%;"></audio>
        <div style="font-size:0.78rem; color:var(--text-muted); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">
          <span>💡 ヒント: 「📄 資料風UI切替」や「🚨 緊急偽装 [Esc]」と組み合わせると背後から見られても完全に学習画面に見えます。</span>
          <a class="btn btn-sm" href="/api/stream/${encodeURIComponent(vid)}?itag=${encodeURIComponent(audioItag)}&download=1" download>🎵 M4A音声を保存</a>
        </div>
      `;
      el.playerAspectBox.appendChild(stageDiv);

      const audioEl = stageDiv.querySelector("#bgm-audio-player");
      audioEl.loop = state.loop;
      audioEl.addEventListener("loadedmetadata", () => {
        if (preserveTime > 0 && preserveTime < audioEl.duration) {
          audioEl.currentTime = preserveTime;
        }
        audioEl.playbackRate = state.currentSpeed;
      });
      audioEl.addEventListener("ended", handleMediaEnded);
      audioEl.src = `/api/stream/${encodeURIComponent(vid)}?itag=${encodeURIComponent(audioItag)}`;
      activeAudioEl = audioEl;
      return;
    }

    // MODE 3: YouTube No-Cookie Embed
    if (state.currentMode === "nocookie") {
      const startParam = preserveTime > 0 ? `&start=${Math.floor(preserveTime)}` : "";
      const wrap = document.createElement("div");
      wrap.style.cssText = "width:100%; height:100%; display:flex; flex-direction:column; background:#000;";
      wrap.innerHTML = `
        <div style="background:#1e293b; color:#cbd5e1; padding:5px 12px; font-size:0.74rem; display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <span>🔒 youtube-nocookie.com 埋め込み再生（※公式MV等で外部サイト埋め込みが禁止されている動画はモード1をご利用ください）</span>
          <button class="btn btn-sm" id="nocookie-to-proxy-btn" style="padding:2px 8px; font-size:0.72rem;">🛡️ モード1 (サーバー中継) で再生</button>
        </div>
      `;
      const iframe = document.createElement("iframe");
      iframe.referrerPolicy = "strict-origin-when-cross-origin";
      iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(vid)}?autoplay=1&rel=0&modestbranding=1&playsinline=1${startParam}`;
      iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen";
      iframe.allowFullscreen = true;
      iframe.style.cssText = "flex:1; width:100%; border:none;";
      wrap.appendChild(iframe);
      el.playerAspectBox.appendChild(wrap);

      const switchBtn = wrap.querySelector("#nocookie-to-proxy-btn");
      if (switchBtn) switchBtn.onclick = () => switchPlaybackMode("proxy");
      return;
    }

    // MODE 4: Lightweight Single-Stream Compatibility Relay / External Mirror
    if (state.currentMode === "mirror") {
      const mirrorBase = (state.settings.mirrorUrl || "https://inv.nadeko.net").replace(/\/+$/, "");
      const wrap = document.createElement("div");
      wrap.style.cssText = "width:100%; height:100%; display:flex; flex-direction:column; background:#000;";

      if (!state.useExternalMirrorIframe) {
        // Default inside Mode 4: Ultra-lightweight single-file progressive MP4 relay (never blocked by X-Frame-Options)
        wrap.innerHTML = `
          <div style="background:#1e293b; color:#cbd5e1; padding:5px 12px; font-size:0.74rem; display:flex; justify-content:space-between; align-items:center; gap:8px;">
            <span>🌐 軽量互換ストリーム中継 (低負荷プログレッシブMP4・単一ストリーム)</span>
            <button class="btn btn-sm" id="toggle-ext-mirror-btn" style="padding:2px 8px; font-size:0.72rem;">🔗 外部ミラー (${escapeHtml(mirrorBase)}) 埋め込みに切替</button>
          </div>
        `;
        const videoEl = document.createElement("video");
        videoEl.controls = true;
        videoEl.autoplay = true;
        videoEl.playsInline = true;
        videoEl.loop = state.loop;
        videoEl.style.cssText = "flex:1; width:100%; height:calc(100% - 32px); background:#000;";
        videoEl.poster = `/api/thumb/${encodeURIComponent(vid)}?q=hq`;
        videoEl.addEventListener("loadedmetadata", () => {
          if (preserveTime > 0 && preserveTime < videoEl.duration) {
            videoEl.currentTime = preserveTime;
          }
          videoEl.playbackRate = state.currentSpeed;
        });
        videoEl.addEventListener("ended", handleMediaEnded);
        videoEl.src = `/api/stream/${encodeURIComponent(vid)}?itag=18`;
        activeVideoEl = videoEl;
        wrap.appendChild(videoEl);
        el.playerAspectBox.appendChild(wrap);

        const extBtn = wrap.querySelector("#toggle-ext-mirror-btn");
        if (extBtn) {
          extBtn.onclick = () => {
            state.useExternalMirrorIframe = true;
            renderPlayerStage(getCurrentPlaybackTime());
          };
        }
      } else {
        const startParam = preserveTime > 0 ? `&t=${Math.floor(preserveTime)}` : "";
        wrap.innerHTML = `
          <div style="background:#1e293b; color:#cbd5e1; padding:5px 12px; font-size:0.74rem; display:flex; justify-content:space-between; align-items:center; gap:8px;">
            <span>🌐 外部ミラー埋め込み: <b>${escapeHtml(mirrorBase)}</b> (※外部サーバーが停止中の場合は左記ボタンで戻せます)</span>
            <button class="btn btn-sm" id="mirror-switch-direct-btn" style="padding:2px 8px; font-size:0.72rem;">⚡ 軽量互換ストリームに戻す</button>
          </div>
          <iframe
            src="${escapeHtml(mirrorBase)}/embed/${encodeURIComponent(vid)}?autoplay=1${startParam}"
            style="flex:1; width:100%; border:none;"
            allow="autoplay; fullscreen"
            allowfullscreen
          ></iframe>
        `;
        el.playerAspectBox.appendChild(wrap);
        const switchBtn = wrap.querySelector("#mirror-switch-direct-btn");
        if (switchBtn) {
          switchBtn.onclick = () => {
            state.useExternalMirrorIframe = false;
            renderPlayerStage(getCurrentPlaybackTime());
          };
        }
      }
    }
  }

  function getCurrentPlaybackTime() {
    if (activeVideoEl) return activeVideoEl.currentTime || 0;
    if (activeAudioEl) return activeAudioEl.currentTime || 0;
    return 0;
  }

  function seekToSeconds(seconds) {
    if (activeVideoEl) {
      activeVideoEl.currentTime = seconds;
      activeVideoEl.play().catch(() => {});
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (activeAudioEl) {
      activeAudioEl.currentTime = seconds;
      activeAudioEl.play().catch(() => {});
      return;
    }
    // For iframe modes, re-render with start time
    renderPlayerStage(seconds);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function switchPlaybackMode(newMode) {
    const curTime = getCurrentPlaybackTime();
    state.currentMode = newMode;
    renderPlayerStage(curTime);
  }

  function applySubtitleTrackState(videoEl) {
    if (!videoEl || !videoEl.textTracks) return;
    for (let i = 0; i < videoEl.textTracks.length; i++) {
      const t = videoEl.textTracks[i];
      t.mode = t.language === state.currentSubtitle ? "showing" : "disabled";
    }
  }

  function handleMediaEnded() {
    if (state.loop) return;
    if (el.autoplayNextCheckbox.checked && state.relatedVideos.length > 0) {
      const nextVideo = state.relatedVideos[0];
      if (nextVideo && nextVideo.id) {
        openVideo(nextVideo.id);
      }
    }
  }

  // =========================================================================
  // Related Videos & Comments
  // =========================================================================
  async function fetchRelatedVideos(vdata) {
    try {
      const q = `${vdata.channel || ""} ${(vdata.title || "").slice(0, 22)}`.trim();
      const resp = await fetch(`/api/related/${encodeURIComponent(vdata.id)}?q=${encodeURIComponent(q)}`);
      if (!resp.ok) throw new Error();
      const data = await resp.json();
      state.relatedVideos = data.results || [];
      renderRelatedList(state.relatedVideos);
    } catch (_) {
      el.relatedList.innerHTML = `<div class="loading-state">関連動画はありません</div>`;
    }
  }

  function renderRelatedList(items) {
    if (!items || items.length === 0) {
      el.relatedList.innerHTML = `<div class="loading-state">関連動画が見つかりませんでした</div>`;
      return;
    }
    el.relatedList.innerHTML = items
      .map(
        (v) => `
      <div class="related-card" data-vid="${escapeHtml(v.id)}">
        <div class="related-thumb-wrap">
          <img src="${escapeHtml(v.thumbnail || `/api/thumb/${v.id}?q=mq`)}" alt="${escapeHtml(v.title)}" loading="lazy" />
          <span class="duration-badge">${formatDuration(v.duration)}</span>
        </div>
        <div class="related-info">
          <div class="related-title" title="${escapeHtml(v.title)}">${escapeHtml(v.title)}</div>
          <div class="related-meta">
            <div>${escapeHtml(v.channel)}</div>
            <div>${v.viewCount ? formatNumber(v.viewCount) + "回視聴" : ""}</div>
          </div>
        </div>
      </div>
    `
      )
      .join("");

    el.relatedList.querySelectorAll(".related-card").forEach((card) => {
      card.addEventListener("click", () => openVideo(card.dataset.vid));
    });
  }

  async function fetchComments(videoId) {
    try {
      const resp = await fetch(`/api/comments/${encodeURIComponent(videoId)}`);
      if (!resp.ok) throw new Error();
      const data = await resp.json();
      const comments = data.comments || [];
      el.commentCountBadge.textContent = comments.length;

      if (comments.length === 0) {
        el.videoComments.innerHTML = `<div class="loading-state">コメントはありません（または無効化されています）</div>`;
        return;
      }

      el.videoComments.innerHTML = comments
        .map(
          (c) => `
        <div class="comment-item">
          <img class="comment-avatar" src="${escapeHtml(c.avatar || "/api/avatar?url=https://example.com")}" alt="avatar" loading="lazy" />
          <div class="comment-body">
            <div class="comment-meta">
              <span class="comment-author">${escapeHtml(c.author)}</span>
              <span class="comment-time">${escapeHtml(c.timeText)}</span>
              ${c.likeCount ? `<span>👍 ${formatNumber(c.likeCount)}</span>` : ""}
            </div>
            <div class="comment-text">${formatDescriptionWithTimestamps(c.text)}</div>
          </div>
        </div>
      `
        )
        .join("");

      el.videoComments.querySelectorAll(".ts-link").forEach((ts) => {
        ts.addEventListener("click", () => seekToSeconds(parseInt(ts.dataset.seek, 10)));
      });
    } catch (_) {
      el.commentCountBadge.textContent = "0";
      el.videoComments.innerHTML = `<div class="loading-state">コメントの取得に失敗しました</div>`;
    }
  }

  // =========================================================================
  // Favorites & Watch History Management
  // =========================================================================
  function addToHistory(vdata) {
    const item = {
      id: vdata.id,
      title: vdata.title,
      channel: vdata.channel,
      duration: vdata.duration,
      viewCount: vdata.viewCount,
      thumbnail: `/api/thumb/${vdata.id}?q=hq`,
      watchedAt: Date.now(),
    };
    state.history = [item, ...state.history.filter((h) => h.id !== vdata.id)].slice(0, 60);
    saveJson(STORAGE_KEYS.HISTORY, state.history);
  }

  function isFavorite(videoId) {
    return state.favorites.some((f) => f.id === videoId);
  }

  function toggleFavoriteCurrent() {
    if (!state.currentVideo) return;
    const vid = state.currentVideo.id;
    if (isFavorite(vid)) {
      state.favorites = state.favorites.filter((f) => f.id !== vid);
    } else {
      state.favorites.unshift({
        id: vid,
        title: state.currentVideo.title,
        channel: state.currentVideo.channel,
        duration: state.currentVideo.duration,
        viewCount: state.currentVideo.viewCount,
        thumbnail: `/api/thumb/${vid}?q=hq`,
      });
    }
    saveJson(STORAGE_KEYS.FAVORITES, state.favorites);
    updateFavCount();
    updateFavoriteButtonUI();
    if (state.activeCategory === "favorites") {
      loadCategoryFeed("favorites");
    }
  }

  function updateFavoriteButtonUI() {
    if (!state.currentVideo) return;
    const fav = isFavorite(state.currentVideo.id);
    el.favoriteToggleBtn.textContent = fav ? "★ お気に入り登録済" : "☆ お気に入り追加";
    el.favoriteToggleBtn.classList.toggle("btn-accent", fav);
  }

  function updateVolumeUI() {
    const pct = state.muted ? 0 : Math.round(state.volume * 100);
    if (el.volumeSlider) el.volumeSlider.value = String(pct);
    if (el.muteToggleBtn) {
      const icon = pct === 0 ? "🔇" : pct < 50 ? "🔉" : "🔊";
      el.muteToggleBtn.textContent = `${icon} ${pct}%`;
    }
    if (activeVideoEl) {
      activeVideoEl.volume = state.volume;
      activeVideoEl.muted = state.muted;
    }
    if (activeAudioEl) {
      activeAudioEl.volume = state.volume;
      activeAudioEl.muted = state.muted;
    }
    sharedAudioEl.volume = state.volume;
    sharedAudioEl.muted = state.muted;
  }

  // =========================================================================
  // Event Listeners Setup
  // =========================================================================
  function initEventListeners() {
    // Logo click -> Close watch view or scroll to feed
    el.homeLogoBtn.addEventListener("click", () => {
      loadCategoryFeed("trending");
    });

    // Search form submit
    el.searchForm.addEventListener("submit", (e) => {
      e.preventDefault();
      executeSearch(el.searchInput.value);
    });

    // Search autocomplete suggestions
    let suggestTimer = null;
    el.searchInput.addEventListener("input", () => {
      const val = el.searchInput.value.trim();
      el.searchClearBtn.classList.toggle("visible", val.length > 0);
      clearTimeout(suggestTimer);
      if (val.length < 1) {
        el.suggestDropdown.classList.remove("open");
        return;
      }
      suggestTimer = setTimeout(async () => {
        try {
          const resp = await fetch(`/api/suggest?q=${encodeURIComponent(val)}`);
          if (!resp.ok) return;
          const data = await resp.json();
          const list = data.suggestions || [];
          if (list.length === 0) {
            el.suggestDropdown.classList.remove("open");
            return;
          }
          el.suggestDropdown.innerHTML = list
            .map((s) => `<div class="suggest-item" data-q="${escapeHtml(s)}">🔍 <span>${escapeHtml(s)}</span></div>`)
            .join("");
          el.suggestDropdown.classList.add("open");
          el.suggestDropdown.querySelectorAll(".suggest-item").forEach((item) => {
            item.addEventListener("click", () => {
              el.searchInput.value = item.dataset.q;
              el.suggestDropdown.classList.remove("open");
              executeSearch(item.dataset.q);
            });
          });
        } catch (_) {}
      }, 180);
    });

    el.searchClearBtn.addEventListener("click", () => {
      el.searchInput.value = "";
      el.searchClearBtn.classList.remove("visible");
      el.suggestDropdown.classList.remove("open");
      el.searchInput.focus();
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".search-container")) {
        el.suggestDropdown.classList.remove("open");
      }
    });

    // Category tabs
    el.categoryTabs.querySelectorAll(".cat-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        loadCategoryFeed(btn.dataset.cat);
      });
    });

    // Playback mode tabs
    el.playbackModeTabs.querySelectorAll(".mode-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        unlockSharedAudio();
        switchPlaybackMode(btn.dataset.mode);
      });
    });

    // Close player button
    el.closePlayerBtn.addEventListener("click", () => {
      cleanupMediaElements();
      el.watchSection.classList.remove("active");
    });

    // Quality selector
    el.qualitySelect.addEventListener("change", () => {
      unlockSharedAudio();
      const curTime = getCurrentPlaybackTime();
      state.currentQualityId = el.qualitySelect.value;
      if (state.currentMode === "proxy") {
        renderPlayerStage(curTime);
      }
    });

    // Volume & Mute controls
    if (el.muteToggleBtn) {
      el.muteToggleBtn.addEventListener("click", () => {
        state.muted = !state.muted;
        if (!state.muted && state.volume === 0) state.volume = 0.8;
        updateVolumeUI();
        if (activeAudioEl && activeVideoEl && !activeVideoEl.paused && activeAudioEl.paused) {
          activeAudioEl.play().catch(() => {});
        }
      });
    }

    if (el.volumeSlider) {
      el.volumeSlider.addEventListener("input", () => {
        const val = parseInt(el.volumeSlider.value, 10) || 0;
        state.volume = Math.max(0, Math.min(1, val / 100));
        state.muted = val === 0;
        updateVolumeUI();
        if (activeAudioEl && activeVideoEl && !activeVideoEl.paused && activeAudioEl.paused) {
          activeAudioEl.play().catch(() => {});
        }
      });
    }

    // Speed selector
    el.speedSelect.addEventListener("change", () => {
      state.currentSpeed = parseFloat(el.speedSelect.value) || 1.0;
      if (activeVideoEl) activeVideoEl.playbackRate = state.currentSpeed;
      if (activeAudioEl) activeAudioEl.playbackRate = state.currentSpeed;
    });

    // Subtitle selector
    el.subtitleSelect.addEventListener("change", () => {
      state.currentSubtitle = el.subtitleSelect.value;
      if (activeVideoEl) {
        applySubtitleTrackState(activeVideoEl);
      }
    });

    // Screen size selector (Stealth small player / Theater mode)
    el.screenSizeSelect.addEventListener("change", () => {
      const val = el.screenSizeSelect.value;
      el.playerStageWrapper.classList.remove("size-65", "size-38");
      el.watchSection.classList.remove("theater-mode");
      if (val === "65") el.playerStageWrapper.classList.add("size-65");
      if (val === "38") el.playerStageWrapper.classList.add("size-38");
      if (val === "theater") el.watchSection.classList.add("theater-mode");
    });

    // Loop toggle
    el.loopToggleBtn.addEventListener("click", () => {
      state.loop = !state.loop;
      el.loopToggleBtn.textContent = state.loop ? "🔁 ループ: ON" : "🔁 ループ: OFF";
      el.loopToggleBtn.classList.toggle("btn-accent", state.loop);
      if (activeVideoEl) activeVideoEl.loop = state.loop;
      if (activeAudioEl) activeAudioEl.loop = state.loop;
    });

    // Picture-in-Picture
    el.pipBtn.addEventListener("click", async () => {
      if (activeVideoEl && document.pictureInPictureEnabled) {
        try {
          if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
          } else {
            await activeVideoEl.requestPictureInPicture();
          }
        } catch (_) {}
      }
    });

    // Channel search click
    el.channelSearchBtn.addEventListener("click", () => {
      if (state.currentVideo && state.currentVideo.channel) {
        el.searchInput.value = state.currentVideo.channel;
        executeSearch(state.currentVideo.channel);
      }
    });

    // Favorite toggle & Copy ID
    el.favoriteToggleBtn.addEventListener("click", toggleFavoriteCurrent);
    el.copyIdBtn.addEventListener("click", () => {
      if (!state.currentVideo) return;
      navigator.clipboard.writeText(state.currentVideo.id).catch(() => {});
      el.copyIdBtn.textContent = "✅ コピー完了";
      setTimeout(() => {
        el.copyIdBtn.textContent = "🔗 IDコピー";
      }, 1500);
    });

    // Detail Sub-tabs (Description / Comments / Study Notes)
    document.querySelectorAll(".detail-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".detail-tab-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const tab = btn.dataset.detailTab;
        el.videoDescription.style.display = tab === "desc" ? "block" : "none";
        el.videoComments.classList.toggle("active", tab === "comments");
        el.videoNotesBox.classList.toggle("active", tab === "notes");
      });
    });

    // Study notes auto-save & timestamp insertion
    el.studyNotesTextarea.addEventListener("input", () => {
      if (!state.currentVideo) return;
      state.notes[state.currentVideo.id] = el.studyNotesTextarea.value;
      saveJson(STORAGE_KEYS.NOTES, state.notes);
    });

    el.insertTimestampBtn.addEventListener("click", () => {
      const cur = Math.floor(getCurrentPlaybackTime());
      const stamp = `[${formatDuration(cur)}] `;
      const ta = el.studyNotesTextarea;
      const start = ta.selectionStart || ta.value.length;
      ta.value = ta.value.slice(0, start) + stamp + ta.value.slice(start);
      ta.focus();
      if (state.currentVideo) {
        state.notes[state.currentVideo.id] = ta.value;
        saveJson(STORAGE_KEYS.NOTES, state.notes);
      }
    });

    // Header Stealth Actions
    el.aboutBlankBtn.addEventListener("click", launchAboutBlankCloak);

    el.themeToggleBtn.addEventListener("click", () => {
      state.settings.themeDoc = !state.settings.themeDoc;
      saveJson(STORAGE_KEYS.SETTINGS, state.settings);
      applySettingsToUI();
    });

    el.stealthSettingsBtn.addEventListener("click", () => {
      el.stealthModal.classList.add("open");
      fetch("/api/cookies")
        .then((r) => r.json())
        .then((d) => {
          const badge = document.getElementById("cookie-status-badge");
          if (badge) {
            badge.textContent = d.active ? `✅ 登録済み (${d.bytes}B)` : "（未設定）";
          }
        })
        .catch(() => {});
    });

    const saveCookiesBtn = document.getElementById("save-cookies-btn");
    const clearCookiesBtn = document.getElementById("clear-cookies-btn");
    const cookiesInput = document.getElementById("youtube-cookies-input");
    const cookieBadge = document.getElementById("cookie-status-badge");

    if (saveCookiesBtn && cookiesInput) {
      saveCookiesBtn.addEventListener("click", async () => {
        try {
          const r = await fetch("/api/cookies", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cookies: cookiesInput.value }),
          });
          const d = await r.json();
          if (cookieBadge) {
            cookieBadge.textContent = d.active ? `✅ 反映完了 (${d.bytes}B)` : "（未設定）";
          }
          cookiesInput.value = "";
        } catch (_) {}
      });
    }
    if (clearCookiesBtn) {
      clearCookiesBtn.addEventListener("click", async () => {
        try {
          await fetch("/api/cookies", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cookies: "" }),
          });
          if (cookieBadge) cookieBadge.textContent = "（解除しました）";
          if (cookiesInput) cookiesInput.value = "";
        } catch (_) {}
      });
    }

    el.closeStealthModalBtn.addEventListener("click", () => {
      el.stealthModal.classList.remove("open");
    });

    el.stealthModal.addEventListener("click", (e) => {
      if (e.target === el.stealthModal) el.stealthModal.classList.remove("open");
    });

    // Cloak preset buttons
    el.cloakPresets.querySelectorAll(".preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.settings.cloakPreset = btn.dataset.preset;
        state.settings.customTitle = "";
        saveJson(STORAGE_KEYS.SETTINGS, state.settings);
        applySettingsToUI();
      });
    });

    el.applyCustomTitleBtn.addEventListener("click", () => {
      state.settings.customTitle = el.customTabTitle.value.trim();
      saveJson(STORAGE_KEYS.SETTINGS, state.settings);
      applySettingsToUI();
    });

    el.panicKeySelect.addEventListener("change", () => {
      state.settings.panicKey = el.panicKeySelect.value;
      saveJson(STORAGE_KEYS.SETTINGS, state.settings);
    });

    el.panicAudioSelect.addEventListener("change", () => {
      state.settings.panicAudio = el.panicAudioSelect.value;
      saveJson(STORAGE_KEYS.SETTINGS, state.settings);
    });

    el.autoPanicBlurCheckbox.addEventListener("change", () => {
      state.settings.autoPanicBlur = el.autoPanicBlurCheckbox.checked;
      saveJson(STORAGE_KEYS.SETTINGS, state.settings);
    });

    el.customMirrorInput.addEventListener("change", () => {
      state.settings.mirrorUrl = el.customMirrorInput.value.trim() || "https://inv.nadeko.net";
      saveJson(STORAGE_KEYS.SETTINGS, state.settings);
      if (state.currentMode === "mirror" && state.currentVideo) {
        renderPlayerStage(getCurrentPlaybackTime());
      }
    });

    el.wipeAllDataBtn.addEventListener("click", () => {
      if (confirm("保存されている再生履歴・お気に入り・メモをすべて消去しますか？")) {
        localStorage.clear();
        state.favorites = [];
        state.history = [];
        state.notes = {};
        updateFavCount();
        el.stealthModal.classList.remove("open");
        loadCategoryFeed("trending");
      }
    });

    // Panic Screen triggers (Button, Return trigger, Keyboard shortcut, Window Blur)
    el.panicTriggerBtn.addEventListener("click", () => togglePanicScreen(true));
    el.panicReturnBtn.addEventListener("click", () => togglePanicScreen(false));

    document.addEventListener("keydown", (e) => {
      const targetKey = state.settings.panicKey || "Escape";
      if (e.key === targetKey || e.code === targetKey) {
        // Close modal first if open
        if (el.stealthModal.classList.contains("open")) {
          el.stealthModal.classList.remove("open");
          return;
        }
        e.preventDefault();
        togglePanicScreen();
      }
    });

    window.addEventListener("blur", () => {
      if (state.settings.autoPanicBlur && !state.panicActive) {
        togglePanicScreen(true);
      }
    });
  }

  // =========================================================================
  // Bootstrap
  // =========================================================================
  function init() {
    applySettingsToUI();
    updateFavCount();
    initEventListeners();
    loadCategoryFeed("trending");
  }

  init();
})();
