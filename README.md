# Lenscape

Lenscape is a mobile-first photo-tourism PWA. Take a city photo, identify a landmark with multimodal AI + location context, retrieve source-aware history, hear an AR-style narrated story, save the memory to a travel diary, build and share a map, export GeoJSON/KML, and optionally join a community leaderboard.

## Current release

**v1.1.0 — final review/hardening pass**

This project deliberately stays dependency-light: static HTML/CSS/JavaScript plus Vercel Functions in `/api`. There is no frontend build step.

## Features

- Responsive mobile-first landing page and scanner
- Live camera capture and gallery upload
- Browser geolocation
- AI landmark recognition through the OpenAI Responses API when configured
- Web-search-grounded history with source links for AI scans
- OpenStreetMap/Overpass + Wikipedia nearby-place fallback if AI is unavailable
- AR-style result view with confidence, verification status, facts, sources, and browser-native narration
- Local-first travel diary with reduced-size photo thumbnails, notes, city/country stats, and XP
- Duplicate landmark prevention using Wikidata IDs when available, with stable name/location fallbacks
- Interactive Leaflet/OpenStreetMap travel map
- Compact shareable travel-map URLs that deliberately omit photos
- GeoJSON and KML export
- Optional Supabase community leaderboard
- Server-signed, short-lived scan verification for leaderboard credit
- Signed HttpOnly anonymous explorer identity for the optional leaderboard
- PWA manifest, install icons, service worker, and offline application shell
- English / Turkish UI

## Important product behavior

### AI vs nearby fallback

An AI scan is marked **verified** locally when recognition confidence is at least 0.75. Community leaderboard credit additionally requires a server-signed short-lived verification token, which is produced when the social signing secret is configured. A location-only OpenStreetMap suggestion can still be saved to the private diary, but it does **not** earn community leaderboard credit. Demo scans never earn leaderboard credit either.

### Travel diary storage

The current result photo stays in memory only. When a landmark is saved, Lenscape stores a reduced-size JPEG thumbnail in local storage rather than the full scan. This substantially reduces browser-quota failures. The app also detects a failed local save and keeps the new entry out rather than pretending it was persisted.

### Shared maps

Shared-map URLs use compact metadata and omit photos. If a diary is large, Lenscape reduces captions and ultimately shares the most recent subset so the URL remains reasonably portable. GeoJSON/KML export remains the better format for very large travel collections.

## Architecture

### `/api/analyze`

1. Accepts a client-compressed JPEG/PNG/WebP image plus optional coordinates.
2. Validates image type/size and coordinate ranges and applies a lightweight server-instance rate limit.
3. If `OPENAI_API_KEY` exists, calls the OpenAI Responses API with image input, web search, and strict structured output.
4. Normalizes text, coordinates, facts, HTTP(S) source URLs, and canonical Wikidata IDs when available before returning them to the browser.
5. High-confidence AI identifications receive a short-lived HMAC verification token when the social signing secret is available.
6. If visual AI is unavailable/fails, attempts a nearby-place fallback through Overpass/OpenStreetMap + Nominatim + Wikipedia.

### `/api/social`

The optional social backend uses Supabase only from the server. Browser clients never receive the service/secret key.

- GET returns the aggregated leaderboard.
- POST accepts only a server-signed, non-expired verified-scan token.
- A signed HttpOnly cookie supplies the anonymous explorer ID instead of trusting a client-provided identity header.
- The database keeps one discovery per explorer + landmark.
- A unique verification-token hash prevents the same signed scan from being replayed across multiple anonymous identities.

This is much harder to spoof than a client-only leaderboard, but it is still an anonymous MVP. For a public competitive launch, add full account authentication and stronger abuse/device-attestation controls.

## Environment variables

Set these in Vercel Project Settings → Environment Variables:

```bash
# True photo recognition + source-aware history
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-6-luna

# Optional shared leaderboard
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...

# Optional: recommended if you want a signing key independent from Supabase.
# If omitted, the server-side Supabase secret is used for HMAC signing.
SOCIAL_SIGNING_SECRET=...
```

Without `OPENAI_API_KEY`, scanning can still use the location-based OpenStreetMap/Wikipedia fallback. Without Supabase variables, diary/map/sharing/export remain functional and the ranking screen shows only local verified progress.

## Supabase setup

Run `supabase/schema.sql` in a dedicated Supabase project. The file is safe to re-run over the earlier Lenscape schema and adds the verification-hash column/index if missing.

The schema:

- enables RLS on public tables,
- revokes browser-role table access,
- grants server/service access explicitly,
- uses a `security_invoker` leaderboard view,
- validates coordinate ranges,
- prevents duplicate explorer + landmark rows,
- prevents replay of the same verified scan token.

## Deploy

Deploy the whole folder to Vercel so `/api/analyze` and `/api/social` are available:

```bash
vercel deploy --prod
```

A plain static server is enough to inspect the UI, but API features will not work there.

## Privacy

- Camera and location permissions are requested only when scanning.
- Local diary photos are stored as reduced-size thumbnails in the browser.
- AI scans send the compressed image to your configured server/OpenAI integration.
- Location fallback requests may query OpenStreetMap/Nominatim/Overpass and Wikipedia.
- Community leaderboard sync never uploads diary photos or personal notes.
- Shared travel-map URLs omit photos; the compact map payload lives in the URL fragment.
- Clearing local diary data does not automatically erase an already-synced cloud leaderboard record.

See `/privacy.html` for the in-app privacy note.

## Security / reliability hardening in v1.1

- JPEG/PNG/WebP allowlist and request-size guard
- Coordinate range validation
- Browser and server scan timeouts
- Lightweight API rate limiting
- HTTP(S)-only source links
- CSP, clickjacking protection, permissions policy, HSTS, and `nosniff`
- No-store API responses
- Server-only OpenAI and Supabase secrets
- HMAC-signed leaderboard verification tokens
- HMAC-signed HttpOnly anonymous explorer cookie
- Verification-token replay protection in PostgreSQL
- Shared-link schema validation and size controls
- Service worker excludes API calls from cache
- Local-storage quota failure handling
- Reduced-motion and keyboard focus styles
- PWA PNG install icons

## Known launch-level limitations

- Map tiles still require a network connection; only the application shell and previously fetched pinned Leaflet runtime are cached.
- The leaderboard is anonymous unless you add real authentication.
- The lightweight in-memory rate limiter is per warm serverless instance, not a globally distributed anti-abuse system. For meaningful public traffic, add platform-level rate limiting/WAF controls.
- Location fallback identifies the most plausible nearby mapped landmark, not the contents of the photo, which is why it is explicitly marked unverified for leaderboard purposes.
