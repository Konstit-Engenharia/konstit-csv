import {
  bench,
  summary,
} from 'mitata';
import {
  comparisonCases,
  comparisonFixtures,
} from './libs-comparison.ts';

// Compare file-to-first-field iteration costs at each fixture size.
for await (const fixture of comparisonFixtures()) {
  summary(() => {
    for (const { name, run } of comparisonCases(fixture)) {
      bench(`${fixture.name}: ${name}`, run);
    }
  });
}
