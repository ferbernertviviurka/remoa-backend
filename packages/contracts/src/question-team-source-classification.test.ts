import { describe, expect, it } from 'vitest';
import { questionSourceAreaCodes, questionTeamDisclosureSchema } from './question-team-publication';
const base={kind:'remoa_team_attested',rightsStatus:'pending',medicalReview:false,explanationStatus:'absent',professionCode:'medicine',flags:[],resolutionEligible:true,declarationDate:'2026-10-19'};
describe('G29 source classification disclosure',()=>{
 it('accepts old snapshots and explicit unclassified state without supplying invented tags',()=>{
  expect(questionTeamDisclosureSchema.parse(base)).toEqual(base);
  expect(questionTeamDisclosureSchema.parse({...base,sourceAreaCodes:[],classificationStatus:'unclassified'}).sourceAreaCodes).toEqual([]);
 });
 it('preserves multiple unreviewed source tags, including non-ENAMED veterinary areas',()=>{
  const value=questionTeamDisclosureSchema.parse({...base,professionCode:'veterinary_medicine',sourceAreaCodes:['clinica-e-cirurgia','saude-publica'],classificationStatus:'source_tags_unreviewed'});
  expect(value.sourceAreaCodes).toEqual(['clinica-e-cirurgia','saude-publica']);
  expect(value.medicalReview).toBe(false);
 });
 it.each([
  {sourceAreaCodes:['clinica-medica'],classificationStatus:'unclassified'},
  {sourceAreaCodes:[],classificationStatus:'source_tags_unreviewed'},
  {sourceAreaCodes:['clinica-medica','clinica-medica'],classificationStatus:'source_tags_unreviewed'},
  {sourceAreaCodes:['invented-topic'],classificationStatus:'source_tags_unreviewed'},
  {sourceAreaCodes:['clinica-medica'],classificationStatus:'reviewed'},
  {sourceAreaCodes:[]}, {classificationStatus:'unclassified'},
  {sourceAreaCodes:[],classificationStatus:'unclassified',correctKey:'A'},
 ])('rejects inconsistent or fabricated classification %#',extra=>{
  expect(questionTeamDisclosureSchema.safeParse({...base,...extra}).success).toBe(false);
 });
 it('allows all frozen tag codes without turning them into IDs or medical topics',()=>{
  for(const code of questionSourceAreaCodes){
   const value=questionTeamDisclosureSchema.parse({...base,sourceAreaCodes:[code],classificationStatus:'source_tags_unreviewed'});
   expect(value).not.toHaveProperty('areaId');expect(value).not.toHaveProperty('topicId');
  }
 });
});

describe('D-1885 source approval disclosure',()=>{
 const approved={sourceRightsStatus:'authorized',sourceApprovalBasis:'remoa_admin_attestation',sourceRightsExpiresAt:'2030-11-19T23:59:59.000Z'};
 it('keeps the question pending while explicitly reporting the separate Remoa source declaration',()=>{
  const value=questionTeamDisclosureSchema.parse({...base,...approved});
  expect(value.rightsStatus).toBe('pending');expect(value.medicalReview).toBe(false);
  expect(value.sourceRightsStatus).toBe('authorized');expect(value.sourceApprovalBasis).toBe('remoa_admin_attestation');
 });
 it('supports the current pending state and historical snapshots without fabricated source approval',()=>{
  expect(questionTeamDisclosureSchema.safeParse({...base,sourceRightsStatus:'pending',sourceApprovalBasis:'unverified',sourceRightsExpiresAt:null}).success).toBe(true);
  expect(questionTeamDisclosureSchema.parse(base)).not.toHaveProperty('sourceApprovalBasis');
 });
 it.each([
  {...approved,sourceApprovalBasis:'unverified'},
  {...approved,sourceRightsExpiresAt:null},
  {...approved,sourceRightsExpiresAt:'invalid-date'},
  {...approved,sourceApprovalBasis:'third_party_license_verified'},
  {sourceRightsStatus:'authorized'},
 ])('rejects unsupported approval assertions %#',extra=>{
  expect(questionTeamDisclosureSchema.safeParse({...base,...extra}).success).toBe(false);
 });
});
