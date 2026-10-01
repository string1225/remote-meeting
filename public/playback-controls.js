// Playback preference belongs to this viewer, and also applies to later peers.
export function createPlaybackControls({ button, container, activate, onError, retryVideos = () => {} }) {
  let muted = false;
  const action = document.createElement('span'), status = document.createElement('small');
  button.classList.add('playback-toggle'); button.type = 'button';
  button.setAttribute('aria-label', '远端声音静音');
  button.replaceChildren(action, status);
  const players = () => [...container.querySelectorAll('audio')];
  function refresh() {
    const audio = players(), playing = audio.filter(player => !player.paused && !player.ended && !player.muted && player.volume > 0).length;
    const state = muted ? 'muted' : !audio.length ? 'waiting' : !playing ? 'blocked' : playing < audio.length ? 'partial' : 'playing';
    button.dataset.state = state; button.setAttribute('aria-pressed', String(muted));
    action.textContent = muted || state === 'blocked' ? '播放远端声音' : '静音远端声音';
    status.textContent = { muted: '已静音', waiting: '等待远端声音', blocked: '待播放', partial: '部分声音已开启', playing: '声音已开启' }[state];
  }
  function play(player) {
    void player.play().catch(error => {
      if (player.isConnected && !muted && error.name !== 'AbortError') onError('声音未能播放，请点击“播放远端声音”重试。');
    }).finally(refresh);
  }
  for (const event of ['play', 'pause', 'volumechange', 'ended', 'emptied']) container.addEventListener(event, refresh, true);
  button.onclick = () => {
    // A blocked autoplay needs a user gesture; a playing output toggles mute.
    muted = !muted && button.dataset.state !== 'blocked';
    if (!muted) { void activate(); retryVideos(); }
    for (const player of players()) {
      player.muted = muted;
      if (!muted) play(player);
    }
    refresh();
  };
  refresh();
  return {
    add(player) { player.muted = muted; refresh(); play(player); },
    refresh,
    reset() { muted = false; refresh(); }
  };
}
