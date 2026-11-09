# Censor Extension for CensorTool

This is a browser extension that automatically scans and censor images (and videos*) on the web. 
It was created to use with [CensorTool](https://github.com/ValentijnvdB/CensorTool).

It was created and tested for Firefox and Firefox-derived browsers. Chrome support is planned. 

*The code in this repo was partially generated using Claude.*

## Installation
Before you start, you need a backend that can censor the images. 
This extension was build to be used in combination with [CensorTool](https://github.com/ValentijnvdB/CensorTool).
However, the endpoints are configurable, so in principle it could be used with others.

1. Download the latest release from the release tab.
2. Go to the 'Manage Extension Page' (Hamburger menu on the top right → Extensions and Themes)
3. Install the extension: cog-wheel → Install add-on from file
4. Configure your preferences: click the three dots → Preferences
5. If you use a self-signed certificate, go to the *connection* tab and test the connection. If it fails, follow the instructions.


## Configuration

The labels you can censor are not built into the extension: they come from the profile the CensorTool server
is running (`GET /profile`), so any YOLO model (v8 or newer) the server loads can be configured.

- Labels are grouped per model. Settings are saved per model, so switching the server between profiles or
  models keeps the settings of each.
- Anything without saved settings (the first start, a new model or a new label) starts from the server's own
  censor config (`GET /censor_config`). *Reset to server* restores those settings.
- *Import from…* copies the settings of another (e.g. a smaller or larger variant of the same) model. Labels
  the other model doesn't have get the server's settings; labels the current model doesn't have are dropped.
- Saved settings of models that are not in the current profile are listed under *Inactive saved configs*.

The settings follow CensorTool's [censor config](https://github.com/ValentijnvdB/CensorTool) (`censor_config.md`).
The same settings are used for images, GIFs and real-time video censoring.
Requires a CensorTool version with the `/profile` and `/censor_config` endpoints and a `/censor_frame` WebSocket
that accepts a config. Settings of earlier versions
of the extension are not migrated.


## Planned
- [ ] Chrome support
- [x] ~~GIF support~~ added in v0.1
- [x] ~~Video support? (Not sure if possible at all & at reasonable performance)~~ Limited video support added in v0.1


## Censor videos

With version v0.1, you can now censor videos in real-time. 
Not all websites are supported, because of how videos are streamed on them.
You need the latest version of the CensorTool and a decent computer that can keep up.

It does not always work perfectly. Sometimes, it freezes or shows a few frames out of order. 
Moving the video back or forward a few seconds fixes this most of the time.
Additionally, the progress bar is stays at 0, however skipping forwards still works.