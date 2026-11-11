# Censor Extension for CensorTool

This is a browser extension that automatically scans and censor images (and videos*) on the web. 
It was created to use with [CensorTool](https://github.com/ValentijnvdB/CensorTool).

It was created and tested for Firefox and Firefox-derived browsers. Chrome support is planned. 

*The code in this repo was partially generated using Claude.*

## Installation
Before you start, you need a backend that can censor the images. 
This extension was build to be used in combination with [CensorTool](https://github.com/ValentijnvdB/CensorTool).

1. Download the latest release from the release tab.
2. Go to the 'Manage Extension Page' (Hamburger menu on the top right → Extensions and Themes)
3. Install the extension: cog-wheel → Install add-on from file
4. Configure your preferences: click the three dots → Preferences
5. Go to the *connection* tab and test the connection (`GET /health`). If you use a self-signed certificate and
   it fails, follow the instructions.


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
Requires a CensorTool version with the `/profile`, `/censor_config`, `/censor_images`, `/health`, `/cache` and
`/storage` endpoints and a `/censor_frame` WebSocket that accepts a config. Settings of earlier versions
of the extension are not migrated.

- *Server check* on the config tab sends the settings to `POST /censor_config/validate` after every change and
  lists the server's errors and warnings. When the server rejects the settings, pages use the server's own
  censor config instead, and the popup shows a warning.
- The *Images* tab of the popup sets how images are sent: several per request (`POST /censor_images`), downloaded
  by the server for public images (the browser still downloads images the server can't get, e.g. ones that need
  a login), and returned as a URL on the server or as base64.
- The *Advanced* tab shows and clears the server's detection cache and stored files.

### Videos

The popup's *Video behavior* has two ways to censor videos:

- *Censor (live)* sends the frames over the `/censor_frame` WebSocket while the video plays, and shows the censored
  picture and the audio a few seconds later (*Delay* in the popup, default 3 s): that is the time the server gets per
  frame. Starting and seeking take that long; after that it plays without buffering. A server that can't keep up
  gives a lower frame rate rather than pauses (the console says when frames come late: raise the delay or lower the
  FPS). Works for streams, long videos and MediaSource sites, if the page lets the extension read the video. The
  audio of a video from another site (a CDN) plays from a second, hidden `<audio>` element, because Firefox gives
  Web Audio only silence for those; it downloads the file a second time and can be up to about 0.2 s out of step for
  a few seconds after starting or seeking. Videos that use the browser's own controls get a simple control bar instead
  (play/pause, seeking, time, mute); on sites with their own player, that player keeps working.
- *Censor (pre-render)* censors the whole video on the server first, as a background job (`POST /videos`), while the
  video stays hidden behind its progress. Then it plays normally, with seeking and audio. Best for short clips.
  Videos without a file URL (most large sites use MediaSource), videos over 100 MB, and videos that don't fit in the
  server's job queue are censored live instead. The server censors each video once: reloading the page, or another
  page with the same video, gets the same job's result (kept for an hour), also while it is still being censored.


## Planned
- [ ] Chrome support
- [x] ~~GIF support~~ added in v0.1
- [x] ~~Video support? (Not sure if possible at all & at reasonable performance)~~ Limited video support added in v0.1


## Censor videos

With version v0.1, you can now censor videos in real-time. 
Not all websites are supported, because of how videos are streamed on them.
You need the latest version of the CensorTool and a decent computer that can keep up.

The picture and audio run a few seconds behind the video (see *Censor (live)* above), so a site's own player shows a
time that is ahead of what you see.