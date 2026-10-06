// Keyboard and gamepad mapping shared by the gameplay page.
export class Input {
  constructor(target = document) {
    this.keys = new Set();
    this.axes = [0, 0];
    this.buttons = [];
    this.previousButtons = [];
    this.state = {forward: false, steer: 0, jump: false, boost: false, drift: 0, lookY: 0};
    this.usingGamepad = false;
    target.addEventListener('keydown', event => {
      if (event.target.tagName === 'INPUT') return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) event.preventDefault();
      this.keys.add(event.code);
    });
    target.addEventListener('keyup', event => this.keys.delete(event.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  read() {
    const pad = navigator.getGamepads?.()[0];
    const state = this.state;
    const keys = this.keys;
    const keyboardForward = keys.has('KeyW') || keys.has('ArrowUp');
    const keyboardSteer = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    state.jump = keys.has('Space');
    state.boost = keys.has('ShiftLeft') || keys.has('ShiftRight');
    state.drift = (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0);
    state.lookY = (keys.has('ArrowDown') ? 1 : 0) - (keys.has('ArrowUp') ? 1 : 0);
    state.centerCamera = keys.has('KeyC');
    state.hint = keys.has('KeyH') || keys.has('Slash');
    state.forward = keyboardForward;
    state.steer = keyboardSteer;
    if (pad) {
      const deadzone = value => (Math.abs(value) > 0.18 ? value : 0);
      const axis = deadzone(pad.axes[0] ?? 0);
      const vertical = pad.axes[1] ?? 0;
      const trigger = Math.max(0, pad.buttons[6]?.value ?? 0) - Math.max(0, pad.buttons[7]?.value ?? 0);
      const buttons = pad.buttons.map(button => button.pressed);
      if (axis || vertical || trigger || buttons.some(Boolean)) this.usingGamepad = true;
      if (this.usingGamepad) {
        const boost = Boolean(buttons[2]) || Boolean(buttons[4]);
        state.steer = axis || state.steer;
        state.boost = state.boost || boost;
        state.forward = state.forward || vertical < -0.25 || boost;
        state.jump = state.jump || Boolean(buttons[0]);
        state.drift = trigger || state.drift;
        state.lookY = -(pad.axes[3] ?? 0) || state.lookY;
        state.centerCamera = state.centerCamera || Boolean(buttons[11]) || Boolean(buttons[9]);
        state.hint = state.hint || Boolean(buttons[3]); // Y / Triangle button
      }
      this.previousButtons = buttons;
      this.axes = [axis, vertical];
    }
    return state;
  }
}
