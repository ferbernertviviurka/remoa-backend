// Split from study-profile.ts so onboarding.ts (waitlist, CCR-161) can import it without the study-profile -> account -> onboarding cycle.
import { z } from 'zod';

/** First 12 must equal healthProfessionCodes (CCR-150, health-taxonomy.ts) so the profile matches question classification. */
export const healthCourseCodes = [
  'medicine', 'psychology', 'dentistry', 'nursing', 'physiotherapy', 'pharmacy',
  'biomedicine', 'nutrition', 'speech_therapy', 'physical_education',
  'veterinary_medicine', 'occupational_therapy',
  'nursing_technician', 'social_work', 'biological_sciences', 'public_health', 'radiology', 'other_health', 'not_health',
] as const;
export const healthCourseCodeSchema = z.enum(healthCourseCodes);
