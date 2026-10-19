# G29 headless publication

Run from the release checkout with Node20+. This CLI calls the audited administrative API. It does not mint tokens, modify auth tables, write SQL directly or change the source corpus.

Dry run (default; verifies 141 lots and 2,108 original file hashes without network):

```sh
node scripts/publish-question-team.mjs --package /absolute/remoa-producao-20261019 --originals /absolute/remoa-questoes-saude-v3
```

Execute only after backend0059 and frontend disclosure are deployed and checked. Supply the legitimate existing human admin session through `REMOA_ADMIN_TOKEN`, or `REMOA_ADMIN_TOKEN_FILE` pointing to a regular file with mode0600. Never pass the token as a command argument. The script checks `/v1/admin/me` and then creates the frozen batch, uploads106 bounded chunks, imports141 exact JSONL lots, activates only the complete28,188-member corpus, and reads status back.

```sh
node scripts/publish-question-team.mjs --package /absolute/remoa-producao-20261019 --originals /absolute/remoa-questoes-saude-v3 --api https://backend.remoa.com.br --checkpoint /absolute/headless-checkpoint.json --execute
```

A minimum2.1-second spacing respects the30actions/minute limit.429 waits at least61seconds; network/5xx retries retain the exact payload and idempotency key. After interruption rerun the same command and checkpoint. The server reconciles committed batches even if the HTTP response was lost. Checkpoint contains operation names, manifest and API origin, never credentials. An expired/revoked session stops the run; a valid new human session may resume the same actor's batch. Errors stop activation, and the API rejects altered membership or incomplete assets. Independent public catalog readback remains required after completion.

Metadata keeps official-exam origin and pending rights; the institutional declaration is not a claim of medical review or copyright clearance. All items appear in the catalog after activation; annulled, conflicting-key or missing-image items do not enter scored pools.
