import { describe, expect, it } from 'vitest';
import { signature, validationOf } from './service';

describe('D-1819 public seal', () => {
  it('institutional → "Remoa", never a name or CRM; medical → reviewer name; private/unreviewed → null', () => {
    const pub = { visibility: 'public', reviewed: true, reviewer_name: 'Fundadora', reviewer_crm: null };
    expect(validationOf({ ...pub, validation_kind: 'remoa_institutional', validation_label: 'Fundadora' })).toEqual({ kind: 'remoa_institutional', label: 'Remoa' });
    expect(validationOf({ ...pub, validation_kind: 'medical_review', validation_label: ' Dra. X ' })).toEqual({ kind: 'medical_review', label: 'Dra. X' });
    expect(validationOf({ ...pub, visibility: 'private', validation_kind: 'remoa_institutional' })).toBeNull();
    expect(validationOf({ ...pub, reviewed: false, validation_kind: 'remoa_institutional' })).toBeNull();
    expect(signature({ ...pub, validation_kind: 'remoa_institutional', reviewer_crm: '1-SP' }, true)).toEqual({ reviewerName: null, reviewerCrm: null, validation: { kind: 'remoa_institutional', label: 'Remoa' } });
    expect(signature({ ...pub, validation_kind: 'medical_review', reviewer_crm: '1-SP' }, true)).toEqual({ reviewerName: 'Fundadora', reviewerCrm: '1-SP', validation: { kind: 'medical_review', label: 'Fundadora' } });
  });
});
