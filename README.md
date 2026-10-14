<div align="center">

<img src="public/logo.png" width="96" height="96" alt="Jimaku Subtitles logo: the characters 字幕 on a violet and blue diamond">

# Jimaku Subtitles for Stremio

**Japanese subtitles from the Jimaku community, inside Stremio.**<br>
For anime, and for Japanese films and series.

<img src="docs/setup-page.webp" width="520" alt="The setup page: your Jimaku key, two options and the install buttons">

</div>

## What it is

[Jimaku](https://jimaku.cc) is where the Japanese subtitle community shares its files. This is a small [Stremio](https://www.stremio.com) addon that finds them for whatever you are watching, so the right Japanese subtitle is already in the player's list. You run it yourself, and it needs one free Jimaku API key.

## What it does

### Finds the subtitle for your episode

It works with the Kitsu, MyAnimeList, AniList and AniDB catalogues and with IMDb titles, and it picks the right season and episode. When a season is only on Jimaku as a ZIP file, the addon opens it and takes out the file for your episode.

### Puts the one made for your release first

If you are playing `[SubsPlease] Show - 05 (1080p).mkv`, the subtitle made for that release goes to the top of the list: it is the one that stays in sync.

### Converts ASS so every app can show it

Most files on Jimaku are ASS, a styled format that many Stremio apps cannot show. The addon converts them to SRT on the way, or keeps the original, or offers both: you choose on the setup page.

## Set it up

1. Get a free API key from [your Jimaku account](https://jimaku.cc/account).
2. Run the addon (below) and open its setup page, `/configure`.
3. Paste the key, press **Test the key**, then press **Install in Stremio**.

The link it makes contains your key, so treat it like a password. Stremio only installs addons over https (except from `localhost`), so to use it away from home, run it somewhere that gives you https.

## Run it yourself

```sh
npm start        # http://localhost:7000/configure
```

It needs Node 20 or newer and nothing else. There is a Dockerfile too, `BASE_URL` sets the public address when it runs behind a proxy, and `npm run dev:mock` runs it against a pretend Jimaku so you can try everything without an account.

## Credits

A fork of [jimaku-subs-stremio](https://github.com/Pedrubik2000/jimaku-subs-stremio) by Pedrubik2000. The subtitles belong to their uploaders in the Jimaku community; titles come from Kitsu, AniList and Cinemeta. Not affiliated with Jimaku or Stremio.

## License

[MIT](LICENSE), with the original author's notice kept.
