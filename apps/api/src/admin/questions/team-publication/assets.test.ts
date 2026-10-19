import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../storage/storage',()=>({headObject:vi.fn(),getBytes:vi.fn(),putBytes:vi.fn()}));
import { headObject, getBytes } from '../../../storage/storage';
import { verifyActivationAssets } from './service';
describe('bounded activation verification',()=>{
 it('awaits all six workers and stops without a proof when any original is unavailable',async()=>{
  let active=0,peak=0;
  vi.mocked(headObject).mockImplementation(async()=>{active++;peak=Math.max(peak,active);await Promise.resolve();active--;return null;});
  await expect(verifyActivationAssets()).rejects.toThrow('team_asset_verification_failed');
  expect(peak).toBe(6);expect(active).toBe(0);expect(headObject).toHaveBeenCalledTimes(6);expect(getBytes).not.toHaveBeenCalled();
 });
});
