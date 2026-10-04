import { seedStudyMaps } from './seed-maps';

await seedStudyMaps();
process.stdout.write('seed maps ok\n');
process.exit(0);
