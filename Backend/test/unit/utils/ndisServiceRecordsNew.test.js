import { describe, it, expect } from 'vitest';
import * as ndisServiceRecordsNew from '../../../src/utils/ndisServiceRecordsNew.js';
import { buildNewNdisMasterPlanServiceRows as impl } from '../../../src/utils/ndisNewMasterPlanServiceHelpers.js';

/*
 * ndisServiceRecordsNew.js is a single re-export line:
 *
 *   export { buildNewNdisMasterPlanServiceRows } from './ndisNewMasterPlanServiceHelpers.js';
 *
 * There is no logic of its own to characterize. It exists to break an import
 * cycle: ndisServiceRecords.js imports the new-pricing row builder through this
 * module, while ndisNewMasterPlanServiceHelpers.js imports the primitives back
 * out of ndisServiceRecords.js. So what is worth pinning is exactly two things —
 * that the one name is re-exported and is the same function object as the
 * implementation, and that resolving it through this hop actually works at
 * runtime (a broken cycle shows up as `undefined is not a function`, not as an
 * import error). The behaviour of the builder itself is covered in
 * ndisNewMasterPlanServiceHelpers.test.js.
 */

describe('ndisServiceRecordsNew re-export', () => {
  // Breaks if the export is renamed or dropped, or if an extra export is added
  // here instead of in the implementation module.
  it('re-exports exactly buildNewNdisMasterPlanServiceRows', () => {
    expect(Object.keys(ndisServiceRecordsNew)).toEqual(['buildNewNdisMasterPlanServiceRows']);
  });

  // Breaks if the re-export is replaced by a wrapper or a copy: consumers rely
  // on this being the very same function, not a lookalike.
  it('is the same function object as the implementation', () => {
    expect(ndisServiceRecordsNew.buildNewNdisMasterPlanServiceRows).toBe(impl);
  });

  // Breaks if the import cycle stops resolving — the re-exported binding would
  // be undefined at call time even though the module imported cleanly.
  it('is callable through the re-export and produces new-pricing rows', () => {
    const rows = ndisServiceRecordsNew.buildNewNdisMasterPlanServiceRows({
      masterPlanItem: {
        itemId: 'mp-1',
        data: {
          'Job Status': 'Completed',
          'Actual Shift Duration(Hr.)': '2',
        },
      },
      servicePlanItem: {
        data: {
          'Unit (Support)': 'Hour',
          'Agreed Unit Price for Support ($)': '80.00',
        },
      },
      supportCatalogue: {},
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe('support');
    expect(rows[0].quantity).toBe(2);
    expect(rows[0].unitPrice).toBe(80);
    expect(rows[0].totalAmount).toBe(160);
  });
});
