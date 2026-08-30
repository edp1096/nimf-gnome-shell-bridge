const {Clutter, Gio, GLib, GObject} = imports.gi;

const BUS_NAME = 'org.nimf.ShellBridge';
const OBJECT_PATH = '/org/nimf/ShellBridge';
const INTERFACE_NAME = 'org.nimf.ShellBridge1';
const KEY_TIMEOUT_MS = 5000;
const CALL_TIMEOUT_MS = 2000;
const BACKSPACE_KEYVAL = 65288;

const NimfInputMethod = GObject.registerClass({
    GTypeName: 'NimfTiv3InputMethodV2',
},
class NimfInputMethod extends Clutter.InputMethod {
    _init() {
        super._init();

        this._currentFocus = null;
        this._preeditVisible = false;
        this._enabled = true;
        this._deferPreedit = false;
        this._pendingPreedit = null;
        this._preeditDelayId = 0;
        this._backspaceRepeatId = 0;
        this._backspaceToken = 0;
        this._backspaceKey = null;
        this._keyboardSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.peripherals.keyboard',
        });
        this._cancellable = new Gio.Cancellable();
        this._proxy = Gio.DBusProxy.new_for_bus_sync(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES,
            null,
            BUS_NAME,
            OBJECT_PATH,
            INTERFACE_NAME,
            null);

        if (typeof this.focus_in !== 'function' ||
            typeof this.focus_out !== 'function')
            throw new Error('Clutter.InputMethod focus API is unavailable');

        this._available = false;
        this._signalId = this._proxy.connect(
            'g-signal', this._onBridgeSignal.bind(this));
        this._ownerId = this._proxy.connect(
            'notify::g-name-owner', this._onBridgeOwnerChanged.bind(this));
        this._preeditNotifyId = this.connect('notify::can-show-preedit', () => {
            this._callVoid('SetUsePreedit', new GLib.Variant('(b)', [true]));
        });
        this._onBridgeOwnerChanged();
    }

    get currentFocus() {
        return this._currentFocus;
    }

    _onBridgeOwnerChanged() {
        const owner = this._proxy.get_name_owner();

        this._available = false;
        if (owner === null) {
            this._clearPreedit();
            log('Nimf text-input-v3 bridge is waiting for its service');
            return;
        }

        this._proxy.call(
            'Ping',
            null,
            Gio.DBusCallFlags.NONE,
            CALL_TIMEOUT_MS,
            this._cancellable,
            (proxy, result) => {
                if (!this._enabled || proxy.get_name_owner() !== owner)
                    return;

                try {
                    const [bridgeVersion, nimfAbi] =
                        proxy.call_finish(result).deep_unpack();
                    if (bridgeVersion !== '2') {
                        log(`Unsupported Nimf bridge version ${bridgeVersion}`);
                        return;
                    }

                    this._available = true;
                    this._callVoid(
                        'SetUsePreedit', new GLib.Variant('(b)', [true]));
                    if (this._currentFocus) {
                        this._callVoid('FocusIn');
                        this._requestSurrounding();
                    }
                    log(`Nimf text-input-v3 bridge connected (${nimfAbi})`);
                } catch (error) {
                    if (!error.matches(
                        Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        log(`Nimf bridge handshake failed: ${error.message}`);
                }
            });
    }

    _callVoid(method, parameters = null) {
        if (!this._enabled || !this._available)
            return;

        this._proxy.call(
            method,
            parameters,
            Gio.DBusCallFlags.NONE,
            CALL_TIMEOUT_MS,
            this._cancellable,
            (proxy, result) => {
                try {
                    proxy.call_finish(result);
                } catch (error) {
                    if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        log(`Nimf bridge ${method} failed: ${error.message}`);
                }
            });
    }

    _requestSurrounding() {
        if (!this._currentFocus)
            return;

        this.emit('request-surrounding');
    }

    _finishTransition() {
        if (this._preeditDelayId)
            GLib.source_remove(this._preeditDelayId);
        this._preeditDelayId = 0;
        this._pendingPreedit = null;
        this._deferPreedit = false;
        this._preeditVisible = false;
        this._cancelBackspaceRepeat();
    }

    _clearPreedit() {
        if (this._preeditDelayId)
            GLib.source_remove(this._preeditDelayId);
        this._preeditDelayId = 0;
        this._pendingPreedit = null;
        this._deferPreedit = false;
        this._cancelBackspaceRepeat();
        if (this._preeditVisible && this._currentFocus)
            this.set_preedit_text(null, 0, Clutter.PreeditResetMode.CLEAR);
        this._preeditVisible = false;
    }

    _queueDeferredPreedit(text, cursor) {
        this._deferPreedit = false;
        this._pendingPreedit = {text, cursor};
        if (this._preeditDelayId)
            GLib.source_remove(this._preeditDelayId);
        this._preeditDelayId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 10, () => {
                this._preeditDelayId = 0;
                const pending = this._pendingPreedit;
                this._pendingPreedit = null;
                if (pending && this._enabled && this._currentFocus) {
                    this._preeditVisible = true;
                    this.set_preedit_text(
                        pending.text,
                        pending.cursor,
                        Clutter.PreeditResetMode.COMMIT);
                }
                return GLib.SOURCE_REMOVE;
            });
    }

    _applyCommit(text) {
        if (!this._currentFocus)
            return;

        if (this._preeditDelayId)
            GLib.source_remove(this._preeditDelayId);
        this._preeditDelayId = 0;
        this._pendingPreedit = null;
        this._deferPreedit = true;
        if (this._preeditVisible) {
            this.set_preedit_text(
                null, 0, Clutter.PreeditResetMode.CLEAR);
        }
        this._preeditVisible = false;
        this.commit(text);
    }

    _applyPreedit(text, cursor, visible) {
        if (!this._currentFocus)
            return;

        if (visible && text.length > 0 &&
            (this._deferPreedit || this._pendingPreedit)) {
            this._queueDeferredPreedit(text, cursor);
            return;
        }
        const preeditVisible = visible && text.length > 0;
        this._preeditVisible = preeditVisible;
        this.set_preedit_text(
            preeditVisible ? text : null,
            cursor,
            preeditVisible
                ? Clutter.PreeditResetMode.COMMIT
                : Clutter.PreeditResetMode.CLEAR);
    }

    _stopBackspaceTimer() {
        if (this._backspaceRepeatId)
            GLib.source_remove(this._backspaceRepeatId);
        this._backspaceRepeatId = 0;
    }

    _cancelBackspaceRepeat() {
        this._stopBackspaceTimer();
        this._backspaceToken++;
        this._backspaceKey = null;
    }

    _scheduleBackspaceRepeat(delay, token) {
        this._stopBackspaceTimer();
        this._backspaceRepeatId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, Math.max(1, delay), () => {
                this._backspaceRepeatId = 0;
                this._repeatBackspace(token);
                return GLib.SOURCE_REMOVE;
            });
    }

    _startBackspaceRepeat(event) {
        this._cancelBackspaceRepeat();
        this._backspaceKey = {
            keycode: event.get_key_code() >>> 0,
            state: (event.get_state() &
                Clutter.ModifierType.MODIFIER_MASK) >>> 0,
        };
        if (!this._keyboardSettings.get_boolean('repeat'))
            return;

        const token = this._backspaceToken;
        this._scheduleBackspaceRepeat(
            this._keyboardSettings.get_uint('delay'), token);
    }

    _repeatBackspace(token) {
        const key = this._backspaceKey;
        if (!this._enabled || !this._available || !this._currentFocus ||
            !key || token !== this._backspaceToken)
            return;

        const parameters = new GLib.Variant('(uuuub)', [
            BACKSPACE_KEYVAL, key.keycode, key.state, 0, true,
        ]);
        this._proxy.call(
            'FilterKeyEventOrdered',
            parameters,
            Gio.DBusCallFlags.NONE,
            KEY_TIMEOUT_MS,
            this._cancellable,
            (proxy, result) => {
                if (!this._enabled || !this._backspaceKey ||
                    token !== this._backspaceToken)
                    return;

                try {
                    const [
                        handled,
                        committedText,
                        preeditChanged,
                        preeditText,
                        preeditCursor,
                        preeditVisible,
                    ] = proxy.call_finish(result).deep_unpack();
                    if (committedText.length > 0)
                        this._applyCommit(committedText);
                    if (preeditChanged) {
                        this._applyPreedit(
                            preeditText, preeditCursor, preeditVisible);
                    }
                    if (!handled) {
                        const time = Math.floor(
                            GLib.get_monotonic_time() / 1000) >>> 0;
                        this.forward_key(
                            BACKSPACE_KEYVAL, key.keycode, key.state, time, true);
                        this.forward_key(
                            BACKSPACE_KEYVAL, key.keycode, key.state, time, false);
                    }
                    this._scheduleBackspaceRepeat(
                        this._keyboardSettings.get_uint('repeat-interval'),
                        token);
                } catch (error) {
                    if (!error.matches(
                        Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        log(`Nimf Backspace repeat failed: ${error.message}`);
                    this._cancelBackspaceRepeat();
                }
            });
    }

    _onBridgeSignal(_proxy, _sender, signalName, parameters) {
        if (!this._enabled)
            return;

        if (signalName === 'Commit') {
            const [text] = parameters.deep_unpack();
            this._applyCommit(text);
        } else if (signalName === 'Preedit') {
            const [text, cursor, visible] = parameters.deep_unpack();
            this._applyPreedit(text, cursor, visible);
        } else if (signalName === 'DeleteSurrounding') {
            if (!this._currentFocus)
                return;
            const [offset, nChars] = parameters.deep_unpack();
            try {
                this.delete_surrounding(offset, nChars);
            } catch (error) {
                if (offset < 0 && nChars + offset >= 0)
                    this.delete_surrounding(0, nChars + offset);
                else
                    log(`Nimf delete-surrounding failed: ${error.message}`);
            }
        } else if (signalName === 'RequestSurrounding') {
            if (this._currentFocus)
                this._requestSurrounding();
        } else if (signalName === 'Beep') {
            log('Nimf requested an input-method beep');
        }
    }

    vfunc_focus_in(focus) {
        this._currentFocus = focus;
        this._callVoid('FocusIn');
        this._requestSurrounding();
    }

    vfunc_focus_out() {
        this._callVoid('FocusOut');
        this._clearPreedit();
        this._currentFocus = null;
        this.set_input_panel_state(Clutter.InputPanelState.OFF);
    }

    vfunc_reset() {
        this._callVoid('Reset');
        this._finishTransition();
        if (this._currentFocus)
            this._requestSurrounding();
    }

    vfunc_set_cursor_location(rect) {
        this._callVoid(
            'SetCursorLocation',
            new GLib.Variant('(iiii)', [
                Math.round(rect.get_x()),
                Math.round(rect.get_y()),
                Math.round(rect.get_width()),
                Math.round(rect.get_height()),
            ]));
    }

    vfunc_set_surrounding(text, cursor, anchor) {
        if (text === null)
            return;

        this._callVoid(
            'SetSurrounding',
            new GLib.Variant('(suu)', [text, cursor, anchor]));
    }

    vfunc_update_content_hints(_hints) {
    }

    vfunc_update_content_purpose(_purpose) {
    }

    vfunc_filter_key_event(event) {
        if (!this._enabled || !this._available || !this._currentFocus)
            return false;

        const keySymbol = event.get_key_symbol() >>> 0;
        const state = (event.get_state() &
            Clutter.ModifierType.MODIFIER_MASK) >>> 0;
        const press = event.type() !== Clutter.EventType.KEY_RELEASE;
        const continuingBackspace = keySymbol === BACKSPACE_KEYVAL &&
            press && this._backspaceKey !== null;
        const consumedBackspaceRelease = keySymbol === BACKSPACE_KEYVAL &&
            !press && this._backspaceKey !== null;
        if (continuingBackspace)
            this._stopBackspaceTimer();
        else if (consumedBackspaceRelease)
            this._cancelBackspaceRepeat();
        else if (press && keySymbol !== BACKSPACE_KEYVAL)
            this._cancelBackspaceRepeat();
        const parameters = new GLib.Variant('(uuuub)', [
            keySymbol,
            event.get_key_code() >>> 0,
            state,
            0,
            press,
        ]);

        this._proxy.call(
            'FilterKeyEventOrdered',
            parameters,
            Gio.DBusCallFlags.NONE,
            KEY_TIMEOUT_MS,
            this._cancellable,
            (proxy, result) => {
                if (!this._enabled)
                    return;

                try {
                    const [
                        handled,
                        committedText,
                        preeditChanged,
                        preeditText,
                        preeditCursor,
                        preeditVisible,
                    ] = proxy.call_finish(result).deep_unpack();
                    if (committedText.length > 0)
                        this._applyCommit(committedText);
                    if (preeditChanged) {
                        this._applyPreedit(
                            preeditText, preeditCursor, preeditVisible);
                    }
                    let eventHandled = handled || consumedBackspaceRelease ||
                        continuingBackspace;
                    if (keySymbol === BACKSPACE_KEYVAL && press && handled &&
                        !continuingBackspace)
                        this._startBackspaceRepeat(event);
                    else if (continuingBackspace && !handled) {
                        const time = event.get_time();
                        this.forward_key(
                            keySymbol, event.get_key_code() >>> 0,
                            state, time, true);
                        this.forward_key(
                            keySymbol, event.get_key_code() >>> 0,
                            state, time, false);
                    }
                    this.notify_key_event(event, eventHandled);
                } catch (error) {
                    if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        log(`Nimf key processing failed: ${error.message}`);
                        this.notify_key_event(event, false);
                    }
                }
            });
        return true;
    }

    shutdown() {
        if (!this._enabled)
            return;

        if (this._available) {
            try {
                this._proxy.call_sync(
                    'FocusOut', null, Gio.DBusCallFlags.NONE,
                    CALL_TIMEOUT_MS, null);
            } catch (error) {
                log(`Nimf bridge FocusOut during shutdown failed: ${error.message}`);
            }
        }

        this._enabled = false;
        this._cancellable.cancel();
        this._clearPreedit();
        this._currentFocus = null;
        this.disconnect(this._preeditNotifyId);
        this._proxy.disconnect(this._signalId);
        this._proxy.disconnect(this._ownerId);
        this._proxy = null;
    }
});

let nimfInputMethod = null;
let previousInputMethod = null;

function init() {
}

function enable() {
    if (nimfInputMethod)
        return;

    const backend = Clutter.get_default_backend();
    const candidate = new NimfInputMethod();
    const previous = backend.get_input_method();
    const focus = previous?.currentFocus ?? null;

    try {
        if (focus)
            previous.focus_out();
        backend.set_input_method(candidate);
        if (focus)
            candidate.focus_in(focus);
    } catch (error) {
        backend.set_input_method(previous);
        try {
            if (focus)
                previous.focus_in(focus);
        } catch (restoreError) {
            logError(restoreError, 'Could not restore the previous input focus');
        }
        candidate.shutdown();
        throw error;
    }

    previousInputMethod = previous;
    nimfInputMethod = candidate;
    log('Nimf text-input-v3 input method enabled');
}

function disable() {
    if (!nimfInputMethod)
        return;

    const backend = Clutter.get_default_backend();
    const focus = nimfInputMethod.currentFocus;

    try {
        if (focus)
            nimfInputMethod.focus_out();
        backend.set_input_method(previousInputMethod);
        if (focus)
            previousInputMethod.focus_in(focus);
    } catch (error) {
        logError(error, 'Error while restoring GNOME Shell input method');
        backend.set_input_method(previousInputMethod);
    }

    nimfInputMethod.shutdown();
    nimfInputMethod = null;
    previousInputMethod = null;
    log('Nimf text-input-v3 input method disabled');
}
