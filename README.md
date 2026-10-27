# Ant Colony — minden holder egy hangya

Élő 3D hangyakolónia egy pump.fun **Holder Rewards** coinhoz. Minden holder egy hangya, amelynek a mérete
a tartott mennyiségtől függ. A trade-ekből származó creator fee nem a devhez megy, hanem a coin
on-chain vaultjába (ez a cukorkupac). Onnan a pump.fun időnként automatikusan, SOL-ban kiosztja
a holdereknek. Az oldal ezeket a **valódi kifizetéseket olvassa a láncról** és jeleníti meg.

Az oldal **csak olvas**: nincs privát kulcs, nem kezel pénzt, és nem fizet ki semmit.

## Gyors indítás (demó, token nélkül)

```bash
npm install
npm run dev
```

http://localhost:8787 — egy szimulált kolónia fut, kitalált holderekkel és kifizetésekkel.

## A coin indítása

A pump.fun-on a coin létrehozásakor kapcsold be a **Holder Rewards** opciót, SOL párral.
Ez később nem változtatható. A pump.fun szabályai (lásd https://pump.fun/docs/fees):

- a creator fee a holderekhez megy, a jogosult holderek között a tartott mennyiség arányában;
- jogosult az a tárca, amelyik legalább kb. 20 dollárnyi tokent tart;
- a kiosztás időnként automatikusan fut, ha a vault fedezi a költségtartalékot plusz kb. 20 dollárt.

## Netlify

1. A Netlify-n: **Add new project → Import from Git →** válaszd ki ezt a repót.
   A build beállításokat a `netlify.toml` adja (`npm run build`, a `dist` mappa, és a függvények).
2. **Site configuration → Environment variables** (scope: Functions). Lásd `.env.example`:
   - `TOKEN_MINT` – a coin mint címe. Ha üres, az oldal demó módban fut.
   - `RPC_URL` – Helius RPC URL ajánlott (a holder-lekérés a `getTokenAccounts` metódust használja).
   - `TOKEN_NAME`, `TOKEN_SYMBOL`, `LINK_X`, `LINK_TELEGRAM`, `EXCLUDE_WALLETS`
3. Változók módosítása után: **Deploys → Trigger deploy**.
4. Domain: **Domain management → Add a domain**. Ott vehetsz is, vagy beköthetsz egy meglévőt.

### Hogyan jut az adat az oldalra

- **`sync`** (ütemezett függvény, 2 percenként): beolvassa a holdereket, a vault egyenlegét és az árakat.
  Végigmegy a vault új tranzakcióin. Minden `DistributeFeeToHolders` utasítás egy valódi kifizetés: ki mennyi SOL-t kapott.
  A többi bejövő összeg a vaultba érkező fee. Az eredményt a Netlify Blobs tárolja (`colony` store).
  Ez csak gyorsítótár, bármikor újraépíthető a láncból.
- **`/api/state`**: a jelenet adatai. 5 másodpercig a CDN cache-ből jön, így sok látogató sem terhel.
- **`/api/holder/:wallet`**: keresés a „Find my ant” mezőhöz.

A holder-rewards vault címe a mintből számolható: PDA a pump programon (`6EF8…F6P`), `["holder-rewards", mint]` seedekkel.
Az oldal „How it works” ablakában meg is jelenik, így bárki ellenőrizheti Solscan-en.

Az ütemezett függvény csak a publikált (production) deployon fut. Az első kérésnél, ha még nincs adat,
a `/api/state` maga építi fel az első pillanatképet.

## Szerkezet

```
server/
  config.js     környezeti változók
  chain.js      csak olvasó RPC: holderek, vault, tranzakciók, árak
  indexer.js    kifizetések és események a láncról, a publikus pillanatkép
  demo.js       állapot nélküli demó kolónia (az idő függvénye)
  api.js        közös API a helyi szervernek és a Netlify függvényeknek
  index.js      helyi szerver (npm run dev / npm start)
netlify/
  functions/    state, holder, sync (ütemezett)
  lib/          közös Netlify segédkód (Blobs)
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
