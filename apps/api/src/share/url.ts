import { env } from '@remoa/config';

const webOrigin = () => env().appUrl;
const apiOrigin = () => env().apiOrigin;

/** FR-12: the link the owner shares. */
export const shareUrlOf = (token: string | null) => (token ? `${webOrigin()}/m/${token}` : null);

/** Image served by the API (never a presigned R2 URL: its path carries the owner's id). */
export const sharedAssetUrl = (token: string, assetId: string, variant: string, exp: number, sig: string) =>
  `${apiOrigin()}/v1/public/shared/${token}/assets/${assetId}/${variant}?e=${exp}&s=${sig}`;
