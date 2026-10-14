// Split from study-profile.ts so onboarding.ts (waitlist, CCR-161) can import it without the study-profile -> account -> onboarding cycle.
import { z } from 'zod';

import { healthCourseCodes } from './study-profile-core';
export { healthCourseCodes };
export const healthCourseCodeSchema = z.enum(healthCourseCodes);
