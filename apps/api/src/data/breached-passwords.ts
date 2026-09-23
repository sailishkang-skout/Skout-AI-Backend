/**
 * AUTH-BE-11 — a small local list of extremely common / breached passwords, checked at
 * signup/reset time so the top offenders are rejected without a network call. This is
 * deliberately not exhaustive (the ticket's "optional HIBP k-anonymity check behind a flag"
 * covers real breach-corpus coverage later) — it exists to catch the passwords that show up
 * at the top of every breach-frequency list year after year.
 *
 * Matching is case-insensitive and exact (not substring) against the whole password.
 */
export const COMMON_BREACHED_PASSWORDS: ReadonlySet<string> = new Set(
  [
    "123456", "password", "123456789", "12345678", "12345", "1234567", "qwerty",
    "abc123", "password1", "111111", "123123", "1234567890", "1q2w3e4r", "qwerty123",
    "iloveyou", "000000", "letmein", "monkey", "dragon", "football", "baseball",
    "welcome", "welcome1", "admin", "admin123", "sunshine", "master", "shadow",
    "superman", "michael", "jennifer", "jordan", "hunter2", "trustno1", "starwars",
    "princess", "login", "passw0rd", "p@ssw0rd", "p@ssword", "qwertyuiop", "1qaz2wsx",
    "zaq12wsx", "asdfghjkl", "asdf1234", "changeme", "letmein1", "password123",
    "password12", "password1234", "12345678910", "987654321", "123321", "666666",
    "121212", "1111111", "11111111", "7777777", "1q2w3e", "qazwsx", "qazwsxedc",
    "computer", "internet", "matrix", "batman", "spiderman", "pokemon", "minecraft",
    "freedom", "whatever", "flower", "hottie", "loveme", "secret", "summer", "winter",
    "autumn", "june2023", "october2023", "january1", "test123", "guest", "demo",
    "temp123", "default", "public", "root", "toor", "letme1n", "abcd1234", "a1b2c3d4",
    "google", "facebook", "instagram", "twitter", "linkedin", "amazon123", "iloveyou1",
    "charlie", "hannah", "michelle", "daniel", "thomas", "andrew", "joshua", "nicole",
  ].map((p) => p.toLowerCase())
);
