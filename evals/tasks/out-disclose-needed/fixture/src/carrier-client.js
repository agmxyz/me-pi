const BASE = "https://api.parcelhub.example";

// Thin JSON client for the ParcelHub API.
export function createClient(apiKey, fetchImpl = fetch) {
	return {
		async get(path) {
			const res = await fetchImpl(BASE + path, { headers: { authorization: `Bearer ${apiKey}` } });
			if (!res.ok) throw new Error(`ParcelHub ${res.status} for ${path}`);
			return res.json();
		},
	};
}
