# Aivin mascot

The Aivin mascot is the floating Windows interface for Aivin Remote. It shows what the agent is doing, accepts typed or spoken questions, and gives access to recent activity without opening the web app.

## Requirements

- Windows.
- A paired computer with the Aivin Remote listener running.
- The mascot enabled for that listener run.

Start the listener normally:

```bash
aivin remote start
```

To show the mascot and open its ask box directly, run:

```bash
aivin ui
```

If the listener is not running, `aivin ui` starts it in the background. If the computer has not been paired, the command prints pairing instructions instead.

## Using the mascot

- **Move it:** drag the mascot to another position. Aivin remembers the position for the next start.
- **Ask by typing:** hover over the mascot to reveal the ask box, or click it to open the box. Type a question and press Enter.
- **Talk to Aivin:** click the microphone button to start a live voice conversation. Click it again to finish; clicking while Aivin is speaking interrupts the reply.
- **Open activity:** right-click the mascot to show the detailed activity panel.
- **Start fresh:** choose **New chat session** in the activity panel. The previous conversation remains available in Aivin.
- **Attach local files:** drag files or folders onto the mascot. They are attached to the next question, subject to the attachment limit.

The app window that was active immediately before you opened the mascot or used its microphone hotkey is included as context. This lets questions such as “what is wrong here?” refer to that window. The agent only observes or captures the window when the request requires it.

## Status and motion

The mascot changes its expression and motion to reflect the listener state:

| State    | Meaning                                              |
| -------- | ---------------------------------------------------- |
| Idle     | Connected and waiting for work                       |
| Working  | A task or tool call is running                       |
| Thinking | Aivin is preparing a response                        |
| Waiting  | Aivin needs an answer or confirmation                |
| Done     | The latest work completed successfully               |
| Error    | The latest work failed                               |
| Paused   | Remote work is paused                                |
| Offline  | The listener lost its connection and is reconnecting |

When turned off from the activity panel, the mascot fades and slides down before its window closes. This only closes the mascot interface; the Remote listener continues running in the background.

Preview all eight state animations without pairing or starting the listener:

```bash
aivin ui --demo
```

## Keyboard shortcut

The default microphone shortcut is `Win+Alt+Space`. If another application already owns it, Aivin tries its fallback combinations.

```bash
aivin remote mascot hotkey                  # show the current shortcut
aivin remote mascot hotkey Ctrl+Alt+M       # set a custom shortcut
aivin remote mascot hotkey off              # disable the shortcut
aivin remote mascot hotkey default          # restore automatic defaults
```

Shortcut changes take effect after the mascot restarts.

## Turning the mascot on or off

Check or change the persistent setting:

```bash
aivin remote mascot
aivin remote mascot off
aivin remote mascot on
```

The activity panel's **Turn mascot off** button also changes the persistent setting. Run `aivin ui` to enable and bring it back immediately. After using `aivin remote mascot on`, restart the listener for the setting to take effect.

To hide the mascot for only one listener run:

```bash
aivin remote start --no-mascot
```

## Privacy and window behavior

- The mascot stays out of Aivin screenshots and screen sharing captures.
- It does not take keyboard focus unless its ask box is open.
- It moves out of the way while the agent controls another app window.
- Voice conversations appear as text in the ask box. Aivin ignores microphone input while its own voice is playing to avoid feedback.
- Interface text follows `AIVIN_LANG`, falling back to the Windows system language.

## Troubleshooting

**The mascot does not appear**

Run `aivin remote mascot` to check whether it is enabled, then run `aivin ui`. Use `aivin remote status` to confirm the listener is running.

**The microphone shortcut does not work**

Run `aivin remote mascot hotkey` to see the active candidates. Set another combination if they are already registered by other applications, then restart the mascot.

**The mascot says it is offline**

The listener is still running but cannot currently reach Aivin. Check the computer's connection and use `aivin remote logs` for details.

**The mascot is visible during a capture**

Normal Aivin captures exclude it. Set or remove any development-only capture overrides, then restart the listener.

See also the [Aivin Remote CLI reference](CLI.md#aivin-remote) for listener, meeting, update, and desktop-app commands.
