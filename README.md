# Ant Colony — minden holder egy hangya

Élő 3D hangyakolónia egy pump.fun **Holder Rewards** coinhoz. Minden holder egy hangya, amelynek a mérete
a tartott mennyiségtől függ. A trade-ekből származó creator fee nem a devhez megy, hanem a coin
on-chain vaultjába (ez a cukorkupac). Onnan a pump.fun időnként automatikusan kiosztja a holdereknek,
a coin párjában: SOL-ban, vagy custom pair esetén abban a tokenben (például PUMP).
Az oldal ezeket a **valódi kifizetéseket olvassa a láncról**.

Az oldal **csak olvas**: nincs privát kulcs, nem kezel pénzt, és nem fizet ki semmit.

## Gyors indítás (demó, token nélkül)

```bash
npm install
npm run dev
```

http://localhost:8787 — egy szimulált kolónia fut, kitalált holderekkel és kifizetésekkel.

## Elég a token mint

A `TOKEN_MINT` megadása után az oldal magától megtalálja a jutalmakat:

- **Vault:** a holder-rewards vault címe a mintből számolható. PDA a pump programon
  (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`), `["holder-rewards", mint]` seedekkel.
- **Reward eszköz:** ha a vaultban SOL van, a jutalom SOL. Ha csak egy token-számla van benne,
  akkor az a token (custom pair). A `REWARD_MINT` változóval felül is írható.
- **Kifizetések:** a vault minden `DistributeFeeToHolders` tranzakciója egy valódi kifizetés.
  A holderekhez jóváírt összeget számolja, a pump.fun crankjének költség-visszatérítését kihagyja.
  A vaultba érkező egyéb összegek fee-beérkezésként jelennek meg.
- **Holderek:** egy Helius RPC-vel (`RPC_URL`) kéri le őket. A pool és a bonding curve kimarad.

Ezt két élő coinon teszteltem: egy SOL-páros és egy PUMP-páros Holder Rewards coin kifizetéseit is helyesen olvasta.

A pump.fun szabályai (lásd https://pump.fun/docs/fees):

- a jutalom a jogosult holderek között a tartott mennyiség arányában oszlik meg;
- jogosult az a tárca, amelyik legalább kb. 20 dollárnyi tokent tart;
- a kiosztás időnként fut, ha a vault fedezi a költségtartalékot (SOL-párnál kb. 0,01, token-párnál kb. 0,20 dollár holderenként) plusz kb. 20 dollárt.

## Vercel

1. Vercel: **Add New → Project →** importáld a `cryko98/ants` repót. A beállításokat a `vercel.json` adja.
2. **Storage → Marketplace → Upstash for Redis → Connect** a projekthez.
   Ez automatikusan beállítja a `KV_REST_API_URL` / `KV_REST_API_TOKEN` változókat.
   Itt tárolódik a kifizetési előzmény. Redis nélkül minden hidegindításkor újraindulna.
3. **Settings → Environment Variables:** `TOKEN_MINT`, `RPC_URL`, `TOKEN_NAME`, `TOKEN_SYMBOL`
   (és opcionálisan `LINK_X`, `LINK_TELEGRAM`, `EXCLUDE_WALLETS`). Lásd `.env.example`.
4. **Redeploy**, majd domain: **Settings → Domains** (ott vehetsz is).

### Frissítés

- **Hobby csomag:** a Vercel Cron itt csak naponta egyszer futhat. Ezért a frissítést a látogatások indítják:
  ha a tárolt pillanatkép 1 percnél régebbi, a `/api/state` a válasz elküldése után a háttérben frissít
  (`waitUntil`). Egy Redis-zár biztosítja, hogy egyszerre csak egy frissítés fusson. Látogatók nélkül nem frissít,
  a következő látogatáskor viszont pótolja a kimaradt tranzakciókat.
- **Pro csomag (opcionális):** percenkénti frissítés látogatók nélkül is. Állíts be egy `CRON_SECRET`-et, és add hozzá
  a `vercel.json`-hoz:
  ```json
  "crons": [{ "path": "/api/sync", "schedule": "* * * * *" }]
  ```
  Hobby csomagon ez a beállítás deploy-hibát okoz.

### API

- `GET /api/state` – a jelenet adatai. 5 másodpercig a CDN cache-ből jön.
- `GET /api/holder/:wallet` – keresés a „Find my ant” mezőhöz.
- `GET /api/sync` – kézi vagy cron-frissítés.

## Szerkezet

```
api/            Vercel függvények: state, holder, sync
server/
  config.js     környezeti változók
  chain.js      csak olvasó RPC: holderek, vault, tranzakciók, árak, token-adatok
  indexer.js    kifizetések és események a láncról, a publikus pillanatkép
  storage.js    tároló: helyi fájl / Upstash Redis
  api.js        közös API (zár, háttérfrissítés)
  vercel.js     Vercel wiring
  demo.js       állapot nélküli demó kolónia
  index.js      helyi szerver (npm run dev / npm start)
src/
  main.js         felület, adatfrissítés, kamera, kereső
  scene/          hangyák (VAT animáció), bolyok, cukorkupac, talaj, fények
public/
  models/ant.glb  CC0 hangya
  logo.png, favicon-*, apple-touch-icon.png
```

## Credit

Hangyamodell: „Ant 3D Model + Rigging + Animated (Low-poly-ish)” – mujtaba-io, CC0
(https://opengameart.org/content/ant-3d-model-rigging-animated-low-poly-ish).
