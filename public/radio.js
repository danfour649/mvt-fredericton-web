/* MVT Fredericton radio — one engine for the whole site.
 *
 * The six stations (each a playlist of banked MVT Fredericton songs
 * streaming from the assets host) play through ONE Audio element that
 * lives as long as the page does, so the radio keeps playing while
 * you drive the 2D game or browse Models / Maps / the 3D tab. Two
 * UIs drive it: the full head unit in the FM tab (index.html) and the
 * mini player in the site header (mountMini below, also used by the
 * standalone /bambam/ page).
 *
 * Plain script, no bundling: index.html and /bambam/ both load it
 * with <script src="/radio.js">, then call MVTRadio.init().
 *
 * While a track is playing, <body> carries .fm-on — the 2D game
 * watches it and silences its own synthesized car radio.
 */
(function () {
  'use strict';
  if (window.MVTRadio) return;

  var BASE = 'https://mvtf-assets.vercel.app/songs/';
  // Presets mirror the MVTF6 game dial where it has a match (CROC,
  // CHSR, CFHA, CFLO, CFSE) plus CKCH for the church pack.
  var STATIONS = [
    { call: 'CROC', freq: '98.5', name: 'Classic Rock', tracks: [
      ['Callie (506-555-0169)', 'callie-506-cr2.ogg'],
      ['High Water', 'high-water.ogg'],
      ['Fiesta on the Wolastoq', 'fiesta-on-the-wolastoq.ogg'],
      ['Fredericton (Bam Bam)', 'fredericton-bambam-a.ogg'],
      ['He Took My Name at Marysville', 'he-took-my-name-at-marysville.ogg']
    ]},
    { call: 'CHSR', freq: '97.9', name: 'Campus / Grunge', tracks: [
      ['Beach Goth Party', 'beach-goth-party.ogg'],
      ['Harmony Corruption', 'harmony-corruption.ogg'],
      ['Woke Up in the Snowbank', 'woke-up-in-the-snowbank.ogg'],
      ['The Bridge Is Breathing', 'the-bridge-is-breathing.ogg'],
      ['Thick Enough', 'thick-enough.ogg'],
      ['Get Me Out of My Mind', 'get-me-out-of-my-mind.ogg'],
      ['Drawn Back Down', 'drawn-back-down.ogg']
    ]},
    { call: 'CFHA', freq: '91.7', name: 'Folk & Roots', tracks: [
      ['Eight Metres Rising (The 2018 Freshet)', 'eight-metres-rising.ogg'],
      ["Marysville (Boss Gibson's Town)", 'marysville.ogg'],
      ['Two Days on the Nashwaak (1696)', 'two-days-on-the-nashwaak.ogg'],
      ['Twenty Shillings (Benedict Arnold)', 'twenty-shillings.ogg']
    ]},
    { call: 'CFLO', freq: '94.3', name: 'Soul & World', tracks: [
      ["One Good Eye (Willie O'Ree)", 'one-good-eye.ogg'],
      ['Light the River (Diwali in Fredericton)', 'light-the-river.ogg']
    ]},
    { call: 'CFSE', freq: '89.5', name: 'Francophone', tracks: [
      ['Pointe-Sainte-Anne (1759)', 'pointe-sainte-anne.ogg'],
      ['Ej Drive à Fredericton', 'ej-drive-a-fredericton.ogg'],
      ['Quinze-Août (Fais du Bruit)', 'quinze-aout.ogg'],
      ['Le Reel de Paquetville', 'le-reel-de-paquetville.ogg'],
      ['Mon Truck, Mon Ski-Doo, Ma Blonde', 'mon-truck.ogg'],
      ['Bleu Nuit', 'bleu-nuit.ogg']
    ]},
    { call: 'CKCH', freq: '102.9', name: 'Sunday / Church', tracks: [
      ['Seventy-One Years to the Water', 'seventy-one-years-to-the-water.ogg'],
      ['O King of Mercy', 'o-king-of-mercy-a.ogg'],
      ['Put Not Your Trust in Princes', 'put-not-your-trust-in-princes.ogg'],
      ['When Evening Falls', 'when-evening-falls.ogg'],
      ['God of the Living Waters', 'god-of-the-living-waters.ogg'],
      ['Cod Be With You', 'cod-be-with-you.ogg'],
      ['Bless Me Father', 'bless-me-father.ogg']
    ]}
  ];

  // What a fresh page opens on (Daniel, 2026-11-23): CHSR, cued to
  // Harmony Corruption. Looked up by call sign + file, so reordering a
  // playlist can't silently cue the wrong song. Selected, not played —
  // browsers block sound before the visitor taps.
  var START = { call: 'CHSR', file: 'harmony-corruption.ogg' };

  // Per-viewer convenience only: the volume.
  function recall(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function remember(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  function fmt(s) {
    if (!isFinite(s)) return '-:--';
    s = Math.max(0, Math.floor(s));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  var R = {
    stations: STATIONS,
    fmt: fmt,
    audio: null,
    si: 0,
    ti: 0,
    failed: false,
    volumeControllable: true,
    _subs: [],
    _wasPlaying: false,

    init: function () {
      if (R.audio) return R;
      var a = R.audio = new Audio();
      a.preload = 'none';
      R.si = 0; R.ti = 0;
      STATIONS.forEach(function (st, i) {
        if (st.call !== START.call) return;
        R.si = i;
        st.tracks.forEach(function (t, j) { if (t[1] === START.file) R.ti = j; });
      });
      var vol = parseInt(recall('mvt-radio-volume') || '80', 10);
      if (!(vol >= 0 && vol <= 100)) vol = 80;
      // iOS ignores element volume (hardware buttons only): probe it,
      // so the UIs can hide a slider that would do nothing.
      a.volume = 0.5;
      R.volumeControllable = Math.abs(a.volume - 0.5) < 0.01;
      a.volume = vol / 100;
      a.addEventListener('ended', function () { R.step(1); });
      a.addEventListener('error', function () { if (a.getAttribute('src')) { R.failed = true; R._emit(); } });
      ['play', 'pause', 'playing', 'waiting', 'loadedmetadata', 'timeupdate', 'durationchange', 'volumechange'].forEach(function (ev) {
        a.addEventListener(ev, function () { R._emit(); });
      });
      if ('mediaSession' in navigator) {
        try {
          navigator.mediaSession.setActionHandler('play', function () { R.play(); });
          navigator.mediaSession.setActionHandler('pause', function () { R.pause(); });
          navigator.mediaSession.setActionHandler('nexttrack', function () { R.step(1); });
          navigator.mediaSession.setActionHandler('previoustrack', function () { R.step(-1); });
        } catch (e) { /* unsupported action */ }
      }
      R.load(false);
      return R;
    },

    /** Subscribe to every state change (called once immediately). */
    on: function (fn) { R._subs.push(fn); fn(R); },
    _emit: function () {
      var on = R.playing();
      if (on !== R._wasPlaying) {
        R._wasPlaying = on;
        document.documentElement.classList.toggle('fm-on', on);
        if (document.body) document.body.classList.toggle('fm-on', on);
        try { window.dispatchEvent(new CustomEvent('mvt-radio-playing', { detail: on })); } catch (e) { /* old engines */ }
      }
      for (var i = 0; i < R._subs.length; i++) R._subs[i](R);
    },

    station: function () { return STATIONS[R.si]; },
    track: function () { return STATIONS[R.si].tracks[R.ti]; },
    playing: function () { return !!R.audio && !R.audio.paused && !R.audio.ended; },
    loading: function () { return R.playing() && R.audio.readyState < 3; },
    stateLabel: function () {
      if (R.failed) return 'NO SIGNAL';
      if (!R.playing()) return 'PAUSED';
      return R.loading() ? 'TUNING…' : 'PLAYING';
    },

    load: function (play) {
      R.failed = false;
      R.audio.src = BASE + R.track()[1];
      R._mediaSession();
      if (play) R.play(); else R._emit();
    },
    play: function () {
      if (R.failed) { R.load(true); return; }
      var p = R.audio.play();
      if (p && p.catch) p.catch(function () { R._emit(); });
    },
    pause: function () { if (R.audio) R.audio.pause(); },
    toggle: function () { if (R.playing()) R.pause(); else R.play(); },
    tune: function (i, play) {
      R.si = (i + STATIONS.length) % STATIONS.length;
      R.ti = 0;
      R.load(play);
    },
    select: function (ti, play) { R.ti = ti; R.load(play); },
    step: function (d) {
      var n = STATIONS[R.si].tracks.length;
      R.ti = (R.ti + d + n) % n;
      R.load(true);
    },
    /** Like every car stereo: back restarts the song unless you're in
     *  its first few seconds. */
    prev: function () {
      if (R.audio.currentTime > 4) { R.audio.currentTime = 0; return; }
      R.step(-1);
    },
    seekFrac: function (f) {
      if (!R.audio.duration) return;
      R.audio.currentTime = R.audio.duration * Math.max(0, Math.min(1, f));
    },
    seekBy: function (s) {
      if (!R.audio.duration) return;
      R.audio.currentTime = Math.max(0, Math.min(R.audio.duration, R.audio.currentTime + s));
    },
    setVolume: function (v) {
      R.audio.volume = Math.max(0, Math.min(100, v)) / 100;
      remember('mvt-radio-volume', String(Math.round(v)));
    },
    volume: function () { return Math.round(R.audio.volume * 100); },

    _mediaSession: function () {
      if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
      var st = R.station();
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: R.track()[0], artist: 'MVT Fredericton',
          album: st.call + ' ' + st.freq + ' FM · ' + st.name,
          artwork: [{ src: '/bambam/poster-720.jpg', sizes: '1280x720', type: 'image/jpeg' }]
        });
      } catch (e) { /* older engines */ }
    }
  };

  // ------------------------------------------------------------------
  // Mini player: a radio pill in the site header + a compact popover.
  //   MVTRadio.mountMini(hostEl, {
  //     openFull: function () {...} | '/#radio',   // "Open the full radio"
  //     swallowOutside: function (target) { return bool }  // eat the
  //       dismissing tap (so it can't also drive the car underneath)
  //   })
  // ------------------------------------------------------------------
  var ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="8" width="19" height="13" rx="2.5"/><path d="M6.5 8 17 3.5"/><circle cx="15.5" cy="14.5" r="3"/><path d="M5.8 12.5h3.6M5.8 15.5h3.6M5.8 18.2h3.6"/></svg>';
  var I_PREV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5v14M19 5 9 12l10 7z"/></svg>';
  var I_NEXT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5v14M5 5l10 7-10 7z"/></svg>';
  var I_PLAY = '<svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg><svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';

  R.mountMini = function (host, opts) {
    if (!host || host.dataset.mounted) return;
    host.dataset.mounted = '1';
    opts = opts || {};
    R.init();
    var openFull = typeof opts.openFull === 'string'
      ? '<a class="mr-full" href="' + opts.openFull + '">Open the full radio <span aria-hidden="true">›</span></a>'
      : '<button type="button" class="mr-full">Open the full radio <span aria-hidden="true">›</span></button>';
    host.innerHTML =
      '<button type="button" class="mr-pill" aria-expanded="false" aria-haspopup="dialog">' +
        '<span class="mr-ico">' + ICON + '</span>' +
        '<span class="mr-eq" aria-hidden="true"><i></i><i></i><i></i></span>' +
        '<span class="mr-label"><b class="mr-call"></b><span class="mr-now"></span></span>' +
      '</button>' +
      '<div class="mr-pop" role="dialog" aria-label="Radio" hidden>' +
        '<div class="mr-top"><span class="mr-led" aria-hidden="true"></span><span class="mr-st"></span>' +
          '<button type="button" class="mr-x" aria-label="Close the radio">✕</button></div>' +
        '<div class="mr-title"></div>' +
        '<div class="mr-bar" role="slider" tabindex="0" aria-label="Track position" aria-valuemin="0" aria-valuemax="100"><i></i></div>' +
        '<div class="mr-times"><span class="mr-state"></span><span class="mr-time"></span></div>' +
        '<div class="mr-ctl">' +
          '<button type="button" class="mr-b mr-prev" aria-label="Previous track">' + I_PREV + '</button>' +
          '<button type="button" class="mr-b mr-play" aria-label="Play">' + I_PLAY + '</button>' +
          '<button type="button" class="mr-b mr-next" aria-label="Next track">' + I_NEXT + '</button>' +
        '</div>' +
        '<div class="mr-presets" role="group" aria-label="Stations"></div>' +
        openFull +
      '</div>';

    var q = function (s) { return host.querySelector(s); };
    var pill = q('.mr-pill'), pop = q('.mr-pop');
    var presets = q('.mr-presets');
    STATIONS.forEach(function (st, i) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'mr-preset';
      b.innerHTML = '<b>' + st.call + '</b><small>' + st.freq + '</small>';
      b.setAttribute('aria-label', st.call + ' ' + st.freq + ', ' + st.name);
      b.addEventListener('click', function () { if (i === R.si && R.playing()) return; R.tune(i, true); });
      presets.appendChild(b);
    });

    function place() {
      // Fixed under the header, right-aligned to the pill: the same
      // code works for the fixed game header and the sticky 3D one.
      var hdr = host.closest('#site-header') || host;
      var hb = hdr.getBoundingClientRect(), pb = pill.getBoundingClientRect();
      pop.style.top = Math.round(hb.bottom + 8) + 'px';
      pop.style.right = Math.max(8, Math.round(window.innerWidth - pb.right)) + 'px';
    }
    function open() {
      pop.hidden = false; pill.setAttribute('aria-expanded', 'true'); place();
      var f = pop.querySelector('.mr-play'); if (f) f.focus({ preventScroll: true });
    }
    function close(refocus) {
      if (pop.hidden) return;
      pop.hidden = true; pill.setAttribute('aria-expanded', 'false');
      if (refocus) pill.focus({ preventScroll: true });
    }
    R.closeMini = close;
    pill.addEventListener('click', function () { if (pop.hidden) open(); else close(); });
    q('.mr-x').addEventListener('click', function () { close(true); });
    q('.mr-play').addEventListener('click', function () { R.toggle(); });
    q('.mr-prev').addEventListener('click', function () { R.prev(); });
    q('.mr-next').addEventListener('click', function () { R.step(1); });
    var bar = q('.mr-bar');
    bar.addEventListener('click', function (e) {
      var r = bar.getBoundingClientRect(); R.seekFrac((e.clientX - r.left) / r.width);
    });
    bar.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { R.seekBy(10); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { R.seekBy(-10); e.preventDefault(); }
    });
    var full = q('.mr-full');
    if (typeof opts.openFull === 'function') full.addEventListener('click', function () { close(); opts.openFull(); });
    window.addEventListener('resize', function () { if (!pop.hidden) place(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(true); });
    // Light dismiss: a tap anywhere else closes the popover. Where the
    // page says so (the live game underneath), that tap is eaten, so
    // closing the radio can't also steer the car.
    var eatClick = false;
    window.addEventListener('pointerdown', function (e) {
      if (pop.hidden || host.contains(e.target)) return;
      close();
      if (opts.swallowOutside && opts.swallowOutside(e.target)) {
        e.stopPropagation(); e.preventDefault(); eatClick = true;
      }
    }, true);
    window.addEventListener('click', function (e) {
      if (eatClick) { eatClick = false; e.stopPropagation(); e.preventDefault(); }
    }, true);

    var title = q('.mr-title'), call = q('.mr-call'), now = q('.mr-now'), stEl = q('.mr-st');
    var stateEl = q('.mr-state'), timeEl = q('.mr-time'), fill = bar.querySelector('i'), playB = q('.mr-play');
    R.on(function () {
      var st = R.station(), on = R.playing(), a = R.audio;
      host.classList.toggle('is-playing', on);
      host.classList.toggle('is-failed', R.failed);
      call.textContent = st.call + ' ' + st.freq;
      now.textContent = R.track()[0];
      stEl.textContent = st.call + ' ' + st.freq + ' · ' + st.name;
      if (title.textContent !== R.track()[0]) title.textContent = R.track()[0];
      stateEl.textContent = R.stateLabel();
      timeEl.textContent = fmt(a.currentTime || 0) + ' / ' + fmt(a.duration);
      var pct = a.duration ? 100 * a.currentTime / a.duration : 0;
      fill.style.width = pct + '%';
      bar.setAttribute('aria-valuenow', String(Math.round(pct)));
      playB.classList.toggle('is-playing', on);
      playB.setAttribute('aria-label', on ? 'Pause' : 'Play');
      pill.setAttribute('aria-label', 'Radio — ' + (on ? 'playing ' + R.track()[0] + ' on ' : 'paused, ') + st.call + ' ' + st.freq);
      presets.querySelectorAll('button').forEach(function (b, i) {
        b.classList.toggle('on', i === R.si); b.setAttribute('aria-pressed', i === R.si ? 'true' : 'false');
      });
    });
  };

  window.MVTRadio = R;
})();
