// The disc's SFD video/audio, converted locally to browser-readable H.264/AAC.
export class Cinematics {
  constructor(video, overlay, onFinish, onError) {
    this.video = video;
    this.overlay = overlay;
    this.onFinish = onFinish;
    this.onError = onError;
    this.queue = [];
    this.token = 0;
    video.addEventListener('ended', () => this.next());
    video.addEventListener('error', () => {
      if (!overlay.hidden) { onError('This movie could not play.'); this.next(); }
    });
  }
  async play(roles, {muted = false, volume = 0.5} = {}) {
    this.token++;
    const token = this.token;
    this.video.pause();
    this.queue = [...roles];
    this.video.muted = muted;
    this.video.volume = volume;
    try {
      const response = await fetch('movies/manifest.json');
      if (!response.ok) throw new Error('Original movies have not been prepared.');
      this.manifest = await response.json();
      if (token !== this.token) return;
      this.overlay.hidden = false;
      await this.next();
    } catch (error) { if (token === this.token) { this.onError(error.message); this.finish(); } }
  }
  async next() {
    const role = this.queue.shift();
    if (!role) { this.finish(); return; }
    const spec = this.manifest[role];
    if (!spec) { this.onError(`${role} movie is unavailable.`); await this.next(); return; }
    const token = ++this.token;
    this.video.src = spec.file;
    this.video.dataset.movie = role;
    this.video.load();
    try { await this.video.play(); }
    catch (error) {
      if (token !== this.token) return;
      if (error.name === 'NotAllowedError') {
        this.video.muted = true;
        try { await this.video.play(); } catch { this.finish(); }
      } else { this.onError(error.message); this.finish(); }
    }
  }
  skip() { this.next(); }
  finish() {
    this.token++;
    this.queue = [];
    this.overlay.hidden = true;
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.onFinish();
  }
}
