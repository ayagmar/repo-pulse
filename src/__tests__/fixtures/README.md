`repo-pulse-feed.input.json` is the public feed contract, copied (then formatted by Biome) from
`packages/contracts/schema/repo-pulse-feed.input.json` in ayagmar/ayagmar.dev at
commit e42eb2aea603bdaeeadccafffa32ef91d05f1825 (ADR 0012). Change the contract there
first, then copy the new file here.

`public-feed-limits.golden.json` holds the `/public/feed` responses for limits 1, 20, 50
and 100 that the implementation reading material per `limit` gave for the scenario in
`public-feed.test.ts`. Reading one copy at the largest limit must answer the same bytes;
regenerate it only for an intended change to the feed's output.
