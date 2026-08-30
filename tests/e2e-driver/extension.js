const {Clutter, Gio, GLib, Meta, Shell} = imports.gi;

const BUS_NAME = 'org.nimf.E2EDriver';
const OBJECT_PATH = '/org/nimf/E2EDriver';
const BUTTON_LEFT = 1;

const interfaceXml = `
<node>
  <interface name="org.nimf.E2EDriver1">
    <method name="ListWindows">
      <arg name="windows_json" type="s" direction="out"/>
    </method>
    <method name="ActivateMaximize">
      <arg name="match" type="s" direction="in"/>
      <arg name="activated" type="b" direction="out"/>
    </method>
    <method name="Keyval">
      <arg name="keyval" type="u" direction="in"/>
    </method>
    <method name="KeyState">
      <arg name="keyval" type="u" direction="in"/>
      <arg name="pressed" type="b" direction="in"/>
    </method>
    <method name="SetHostOffset">
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
    </method>
    <method name="Screenshot">
      <arg name="path" type="s" direction="in"/>
      <arg name="started" type="b" direction="out"/>
    </method>
    <method name="Click">
      <arg name="match" type="s" direction="in"/>
      <arg name="relative_x" type="i" direction="in"/>
      <arg name="relative_y" type="i" direction="in"/>
      <arg name="clicked" type="b" direction="out"/>
    </method>
  </interface>
</node>`;

class Driver {
    constructor() {
        const backend = Clutter.get_default_backend();
        const seat = backend.get_default_seat();

        this._pointer = seat.create_virtual_device(
            Clutter.InputDeviceType.POINTER_DEVICE);
        this._keyboard = seat.create_virtual_device(
            Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._hostX = 0;
        this._hostY = 0;
    }

    _windows() {
        return global.get_window_actors()
            .map(actor => actor.meta_window)
            .filter(window => window !== null);
    }

    _findWindow(match) {
        const needle = match.toLowerCase();
        return this._windows().find(window => {
            const values = [
                window.get_title?.(),
                window.get_wm_class?.(),
                window.get_wm_class_instance?.(),
                window.get_gtk_application_id?.(),
            ];
            return values.some(value =>
                value?.toLowerCase().includes(needle));
        }) ?? null;
    }

    ListWindows() {
        return JSON.stringify(this._windows().map(window => {
            const rect = window.get_frame_rect();
            return {
                title: window.get_title?.() ?? '',
                wmClass: window.get_wm_class?.() ?? '',
                instance: window.get_wm_class_instance?.() ?? '',
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            };
        }));
    }

    ActivateMaximize(match) {
        const window = this._findWindow(match);
        if (!window)
            return false;

        window.maximize(Meta.MaximizeFlags.BOTH);
        window.activate(global.get_current_time());
        return true;
    }

    Keyval(keyval) {
        const time = GLib.get_monotonic_time();
        this._keyboard.notify_keyval(
            time, keyval, Clutter.KeyState.PRESSED);
        this._keyboard.notify_keyval(
            time + 1000, keyval, Clutter.KeyState.RELEASED);
    }

    KeyState(keyval, pressed) {
        this._keyboard.notify_keyval(
            GLib.get_monotonic_time(),
            keyval,
            pressed ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
    }

    SetHostOffset(x, y) {
        this._hostX = x;
        this._hostY = y;
    }

    Screenshot(path) {
        try {
            const file = Gio.File.new_for_path(path);
            const stream = file.replace(
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            const screenshot = new Shell.Screenshot();
            screenshot.screenshot(false, stream, (object, result) => {
                try {
                    object.screenshot_finish(result);
                } catch (error) {
                    log(`Nimf E2E screenshot failed: ${error.message}`);
                }
                try {
                    stream.close(null);
                } catch (error) {
                    log(`Nimf E2E screenshot close failed: ${error.message}`);
                }
            });
            return true;
        } catch (error) {
            log(`Nimf E2E screenshot start failed: ${error.message}`);
            return false;
        }
    }

    Click(match, relativeX, relativeY) {
        const window = this._findWindow(match);
        if (!window)
            return false;

        const rect = window.get_frame_rect();
        const time = GLib.get_monotonic_time();
        this._pointer.notify_absolute_motion(
            time,
            this._hostX + rect.x + relativeX,
            this._hostY + rect.y + relativeY);
        this._pointer.notify_button(
            time + 1000, BUTTON_LEFT, Clutter.ButtonState.PRESSED);
        this._pointer.notify_button(
            time + 2000, BUTTON_LEFT, Clutter.ButtonState.RELEASED);
        return true;
    }
}

let ownerId = 0;
let exportedObject = null;
let driver = null;

function init() {
}

function enable() {
    driver = new Driver();
    ownerId = Gio.bus_own_name(
        Gio.BusType.SESSION,
        BUS_NAME,
        Gio.BusNameOwnerFlags.NONE,
        connection => {
            exportedObject = Gio.DBusExportedObject.wrapJSObject(
                interfaceXml, driver);
            exportedObject.export(connection, OBJECT_PATH);
        },
        null,
        null);
    log('Nimf E2E virtual input driver enabled');
}

function disable() {
    if (exportedObject)
        exportedObject.unexport();
    exportedObject = null;
    if (ownerId)
        Gio.bus_unown_name(ownerId);
    ownerId = 0;
    driver = null;
}
