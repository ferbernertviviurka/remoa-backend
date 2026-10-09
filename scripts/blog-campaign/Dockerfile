# Review-only campaign container; no app boot, migrations, database or maintenance jobs.
FROM node:22-slim
WORKDIR /job
COPY scripts/blog-campaign/run-targeted.mjs ./run-targeted.mjs
USER node
CMD ["node", "run-targeted.mjs", "--execute"]
