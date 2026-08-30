import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS_NAME = 'org.nimf.ShellBridge';
const OBJECT_PATH = '/org/nimf/ShellBridge';
const INTERFACE_NAME = 'org.nimf.ShellBridge1';
const KEY_TIMEOUT_MS = 5000;
const CALL_TIMEOUT_MS = 2000;

const NimfInputMethod = GObject.registerClass({
    GTypeName: 'NimfTiv3InputMethod46V1',
}, class NimfInputMethod extends Clutter.InputMethod {
    _init() {
        super._init();

        this._currentFocus = null;
        this._preeditVisible = false;
        this._enabled = true;
        this._deferPreedit = false;
        this._pendingPreedit = null;
        this._preeditDelayId = 0;
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
            console.log('Nimf text-input-v3 bridge is waiting for its service');
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
                        console.error(
                            `Unsupported Nimf bridge version ${bridgeVersion}`);
                        return;
                    }

                    this._available = true;
                    this._callVoid(
                        'SetUsePreedit', new GLib.Variant('(b)', [true]));
                    if (this._currentFocus) {
                        this._callVoid('FocusIn');
                        this._requestSurrounding();
                    }
                    console.log(
                        `Nimf text-input-v3 bridge connected (${nimfAbi})`);
                } catch (error) {
                    if (!error.matches(
                        Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.error(
                            `Nimf bridge handshake failed: ${error.message}`);
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
                    if (!error.matches(
                        Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.error(
                            `Nimf bridge ${method} failed: ${error.message}`);
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
    }

    _clearPreedit() {
        if (this._preeditDelayId)
            GLib.source_remove(this._preeditDelayId);
        this._preeditDelayId = 0;
        this._pendingPreedit = null;
        this._deferPreedit = false;
        if (this._preeditVisible && this._currentFocus) {
            this.set_preedit_text(
                null, 0, 0, Clutter.PreeditResetMode.CLEAR);
        }
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
                        pending.cursor,
                        Clutter.PreeditResetMode.COMMIT);
                }
                return GLib.SOURCE_REMOVE;
            });
    }

    _onBridgeSignal(_proxy, _sender, signalName, parameters) {
        if (!this._enabled)
            return;

        if (signalName === 'Commit') {
            if (!this._currentFocus)
                return;
            const [text] = parameters.deep_unpack();
            if (this._preeditDelayId)
                GLib.source_remove(this._preeditDelayId);
            this._preeditDelayId = 0;
            this._pendingPreedit = null;
            this._deferPreedit = true;
            this._preeditVisible = false;
            this.commit(text);
        } else if (signalName === 'Preedit') {
            if (!this._currentFocus)
                return;
            const [text, cursor, visible] = parameters.deep_unpack();
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
                cursor,
                preeditVisible
                    ? Clutter.PreeditResetMode.COMMIT
                    : Clutter.PreeditResetMode.CLEAR);
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
                    console.error(
                        `Nimf delete-surrounding failed: ${error.message}`);
            }
        } else if (signalName === 'RequestSurrounding') {
            if (this._currentFocus)
                this._requestSurrounding();
        } else if (signalName === 'Beep') {
            console.log('Nimf requested an input-method beep');
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
        const parameters = new GLib.Variant('(uuuub)', [
            keySymbol,
            event.get_key_code() >>> 0,
            state,
            0,
            press,
        ]);

        this._proxy.call(
            'FilterKeyEvent',
            parameters,
            Gio.DBusCallFlags.NONE,
            KEY_TIMEOUT_MS,
            this._cancellable,
            (proxy, result) => {
                if (!this._enabled)
                    return;

                try {
                    const [handled] = proxy.call_finish(result).deep_unpack();
                    if (!handled) {
                        this.forward_key(
                            keySymbol,
                            event.get_key_code() >>> 0,
                            state,
                            event.get_time(),
                            press);
                    }
                    this.notify_key_event(event, true);
                } catch (error) {
                    if (!error.matches(
                        Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        console.error(
                            `Nimf key processing failed: ${error.message}`);
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
                console.error(
                    `Nimf bridge FocusOut during shutdown failed: ${error.message}`);
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

export default class NimfShellBridgeExtension extends Extension {
    enable() {
        if (this._nimfInputMethod)
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
                console.error(
                    'Could not restore the previous input focus', restoreError);
            }
            candidate.shutdown();
            throw error;
        }

        this._previousInputMethod = previous;
        this._nimfInputMethod = candidate;
        console.log('Nimf text-input-v3 input method enabled');
    }

    disable() {
        if (!this._nimfInputMethod)
            return;

        const backend = Clutter.get_default_backend();
        const focus = this._nimfInputMethod.currentFocus;

        try {
            if (focus)
                this._nimfInputMethod.focus_out();
            backend.set_input_method(this._previousInputMethod);
            if (focus)
                this._previousInputMethod.focus_in(focus);
        } catch (error) {
            console.error(
                'Error while restoring GNOME Shell input method', error);
            backend.set_input_method(this._previousInputMethod);
        }

        this._nimfInputMethod.shutdown();
        this._nimfInputMethod = null;
        this._previousInputMethod = null;
        console.log('Nimf text-input-v3 input method disabled');
    }
}
