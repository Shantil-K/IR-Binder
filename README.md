# IR Binder (webOS, rooted)

Learn any signal the TV's IR receiver passes to Linux and bind it to an action:
power, number keys, volume, navigation and media keys, opening an app, a custom luna call, or a shell command.

## Parts
- **UI app** (`src/index.html`, `src/js/`, `src/css/`): plain JavaScript built like OpenLauncher, so it stays fast on the TV. Focus is a CSS class (`js/dpad.js`) rather than browser focus, there are no focus animations, nothing polls while the app is in the background, and lists only redraw what changed.
- **Daemon** (`src/daemon/irbindd.js`): runs as root and reads `/dev/input/event*`.
  It keeps running after you close the app and starts on boot through Homebrew Channel's `init.d`.
  Its API is on `127.0.0.1:8765`, bindings are in `/var/lib/irbind/bindings.json`, and the log is `/tmp/irbindd.log`.

## Install
```sh
./build.sh
ares-install -d <tv> dist/com.anymote.irbind_1.1.0_all.ipk
```
Open **IR Binder** on the TV and press **Install & start service**. This needs Homebrew Channel with root.
To start it by hand over SSH, run:
`sh /media/developer/apps/usr/palm/applications/com.anymote.irbind/daemon/install.sh`

## Use
1. Press **Learn new signal** and press a button on any remote.
2. Pick an action. For volume, channel and arrow keys, turn on "Repeat while held".
3. The **Live signals** panel shows every signal the TV sees, so you can check what reaches the system.

## Limits
- The TV's microcontroller decodes IR before Linux sees it, so some remotes' codes may never arrive.
  Check the Live signals panel.
- A bound LG remote key still does its normal job too. Bindings add an action; they don't replace the key.
- With the TV fully off (standby), the main system is asleep. Only the TV's own power code can wake it.

## License
GPL-3.0-or-later. See [LICENSE](LICENSE).
