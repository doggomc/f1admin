'use strict';

// Inserted only into the stripped player. Some Android browsers leave a muted
// secondary JW video paused until tapped, despite the host's autoplay request.
// Make a bounded attempt when media becomes playable; do not restart a video
// after it has played, or attempt unmuted playback without a user gesture.
function installMutedAutoplay() {
  const params = new URLSearchParams(location.search);
  if (params.get('autoplay') !== '1' || params.get('mute') !== '1') return;
  const seen = new WeakSet();
  let finished = false;
  let wantsMuted = true;
  window.addEventListener('message', (event) => {
    try {
      const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      if (data && data.type === 'freef1-audio') wantsMuted = Boolean(data.muted);
    } catch (_) { /* unrelated frame messages */ }
  });
  const attach = (video) => {
    if (seen.has(video)) return;
    seen.add(video);
    video.muted = wantsMuted;
    video.defaultMuted = wantsMuted;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    let started = false;
    let pending = false;
    let attempts = 0;
    const play = () => {
      if (finished || started || pending || attempts >= 4 || !wantsMuted || video.readyState < 2) return;
      video.muted = true;
      attempts++;
      try {
        pending = true;
        Promise.resolve(video.play()).catch(() => {}).finally(() => { pending = false; });
      } catch (_) { pending = false; }
    };
    video.addEventListener('playing', () => { started = true; }, { once: true });
    video.addEventListener('loadeddata', play);
    video.addEventListener('canplay', play);
    video.addEventListener('canplaythrough', play);
    play();
  };
  const scan = () => { if (typeof document !== 'undefined' && document) document.querySelectorAll('video').forEach(attach); };
  const observer = new MutationObserver(scan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scan();
  setTimeout(() => { finished = true; observer.disconnect(); }, 60000);
}

module.exports = { mutedAutoplayScript: `(${installMutedAutoplay.toString()})();` };
