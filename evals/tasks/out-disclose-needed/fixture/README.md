# shop

Shipping quotes come from the ParcelHub API (`https://api.parcelhub.example`), authenticated with the `PARCELHUB_API_KEY` set in production. Tests pass a fake client to `getQuote`, so `npm test` needs no network or key.
