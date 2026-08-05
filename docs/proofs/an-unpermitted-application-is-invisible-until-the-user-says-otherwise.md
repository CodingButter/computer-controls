# An unpermitted application is invisible until the user says otherwise

- Measured: 2026-08-05T07:08:19.621Z
- Hub: http://127.0.0.1:4111
- Application: Discord
- Config: `/home/codingbutter/.config/mastracode-desktop/config.json`

**The claim holds.**

## Measurements

| Step | Result | Measured |
| --- | --- | --- |
| Discord is unpermitted | held | mode=per-application permitted=false readable=false running=false |
| the answer says there is no permission yet | held | status=200 namesApp=true namesPermission=true |
| permitting it changes the ceiling without a restart | held | put=200 mode=per-application inFile=true permitted=true readable=true |
| the launcher is cured | held | cured=[] alreadyCured=["Discord","Google Chrome","Visual Studio Code"] |
| Discord reads as a real tree | held | readable now (it was launched from a cured shortcut) |

## Detail

```json
[
  {
    "name": "Discord is unpermitted",
    "measured": "mode=per-application permitted=false readable=false running=false",
    "held": true,
    "detail": {
      "modeAtStart": "per-application",
      "permittedAtStart": true,
      "restoredToUnpermitted": true
    }
  },
  {
    "name": "the answer says there is no permission yet",
    "measured": "status=200 namesApp=true namesPermission=true",
    "held": true,
    "detail": {
      "reply": "{\"text\":\"Discord doesn't have permission to be inspected. You'd need to grant it access on the Permissions page first.\",\"threadId\":\"da460114-38e3-4ec4-ad7c-c8f5f1576c45\",\"status\":\"completed\"}"
    }
  },
  {
    "name": "permitting it changes the ceiling without a restart",
    "measured": "put=200 mode=per-application inFile=true permitted=true readable=true",
    "held": true,
    "detail": {
      "configPath": "/home/codingbutter/.config/mastracode-desktop/config.json",
      "modeBefore": "per-application",
      "modeAfter": "per-application",
      "applicationsCount": 41
    }
  },
  {
    "name": "the launcher is cured",
    "measured": "cured=[] alreadyCured=[\"Discord\",\"Google Chrome\",\"Visual Studio Code\"]",
    "held": true,
    "detail": {
      "cured": [],
      "alreadyCured": [
        {
          "name": "Discord",
          "desktopId": "discord.desktop"
        },
        {
          "name": "Google Chrome",
          "desktopId": "google-chrome.desktop"
        },
        {
          "name": "Visual Studio Code",
          "desktopId": "code.desktop"
        }
      ],
      "needsRestart": []
    }
  },
  {
    "name": "Discord reads as a real tree",
    "measured": "readable now (it was launched from a cured shortcut)",
    "held": true
  }
]
```

The script arranged none of this. It asked the hub the same questions the
page asks, wrote through the same route the page writes through, and copied
down what came back.
