/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define([
  'N/ui/serverWidget',
  'N/query',
  'N/log',
  'N/runtime',
  'N/record',
  'N/format'
], (ui, query, log, runtime, record, format) => {

  const PAGE_SIZE = 1000;
  const MAX_UI_ROWS = 500;

  const PARAM_ACCOUNT = 'custscript_icr_adj_account';
  const PARAM_LOCATION = 'custscript_icr_location';
  const PARAM_SUBSIDIARY = 'custscripticr_subsidiary';
  const PARAM_MAX = 'custscript_icr_max_per_run';

  const ICR_RECORD_TYPE = 'inventorycostrevaluation';

  // Items to skip manually
  const SKIP_ITEM_IDS = {
    17647: '175-0278-00 has cost category/location validation issue'
  };

  function esc(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getParam(name) {
    return runtime.getCurrentScript().getParameter({ name });
  }

  function getMaxPerRun() {
    return Number(getParam(PARAM_MAX) || 1);
  }

  function parseNsDate(mmddyyyy) {
    return format.parse({
      value: String(mmddyyyy),
      type: format.Type.DATE
    });
  }

  function getSuggestedDate(dateValue) {
    const parts = String(dateValue || '').split('/');
    if (parts.length !== 3) return '';

    const d = new Date(
      Number(parts[2]),
      Number(parts[0]) - 1,
      Number(parts[1])
    );

    d.setDate(d.getDate() - 1);

    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  }

  function getSql() {
    return `
      WITH raw_first_transaction AS (
        SELECT *
        FROM (
          SELECT
            i.id AS item_internal_id,
            i.itemid AS itemid,
            BUILTIN.DF(i.itemtype) AS itemtype,
            t.id AS first_transaction_internal_id,
            t.trandate AS first_transaction_date,
            t.tranid AS first_transaction_number,
            t.type AS first_transaction_type_id,
            BUILTIN.DF(t.type) AS first_transaction_type,
            NVL(t.posting, 'F') AS posting,
            NVL(tl.isinventoryaffecting, 'F') AS isinventoryaffecting,
            ROW_NUMBER() OVER (
              PARTITION BY i.id
              ORDER BY t.trandate ASC, t.id ASC
            ) AS rn
          FROM
            item i
            INNER JOIN transactionline tl ON tl.item = i.id
            INNER JOIN transaction t ON t.id = tl.transaction
          WHERE
            i.itemtype IN ('InvtPart', 'Assembly')
            AND t.type IS NOT NULL
            AND NVL(t.voided, 'F') = 'F'
        )
        WHERE rn = 1
      ),

      first_icr AS (
        SELECT *
        FROM (
          SELECT
            i.id AS item_internal_id,
            t.id AS first_icr_internal_id,
            t.trandate AS first_icr_date,
            t.tranid AS first_icr_number,
            ROW_NUMBER() OVER (
              PARTITION BY i.id
              ORDER BY t.trandate ASC, t.id ASC
            ) AS rn
          FROM
            item i
            INNER JOIN transactionline tl ON tl.item = i.id
            INNER JOIN transaction t ON t.id = tl.transaction
          WHERE
            i.itemtype IN ('InvtPart', 'Assembly')
            AND NVL(t.voided, 'F') = 'F'
            AND t.type = 'InvReval'
        )
        WHERE rn = 1
      )

      SELECT
        rft.item_internal_id,
        rft.itemid,
        rft.itemtype,
        rft.first_transaction_date,
        rft.first_transaction_type,
        rft.first_transaction_number,
        rft.first_transaction_internal_id,
        rft.posting,
        rft.isinventoryaffecting,
        ficr.first_icr_date,
        ficr.first_icr_number,
        ficr.first_icr_internal_id,
        CASE
          WHEN rft.posting = 'T' OR rft.isinventoryaffecting = 'T'
          THEN 'REAL ISSUE'
          ELSE 'NON-POSTING ONLY'
        END AS issue_category
      FROM
        raw_first_transaction rft
        LEFT JOIN first_icr ficr
          ON ficr.item_internal_id = rft.item_internal_id
      WHERE
        rft.first_transaction_type_id <> 'InvReval'
      ORDER BY
        rft.first_transaction_date ASC,
        rft.itemid ASC
    `;
  }

  function getRows() {
    const rows = [];

    const paged = query.runSuiteQLPaged({
      query: getSql(),
      pageSize: PAGE_SIZE
    });

    paged.pageRanges.forEach(pageRange => {
      const page = paged.fetch({ index: pageRange.index });

      page.data.asMappedResults().forEach(row => {
        row.required_icr_date = getSuggestedDate(row.first_transaction_date);
        rows.push(row);
      });
    });

    return rows;
  }

  function createIcr(row) {
    const accountId = getParam(PARAM_ACCOUNT);
    const locationId = getParam(PARAM_LOCATION);
    const subsidiaryId = getParam(PARAM_SUBSIDIARY);

    if (!accountId) throw new Error(`Missing script parameter ${PARAM_ACCOUNT}`);
    if (!locationId) throw new Error(`Missing script parameter ${PARAM_LOCATION}`);
    if (!subsidiaryId) throw new Error(`Missing script parameter ${PARAM_SUBSIDIARY}`);

    const rec = record.create({
      type: ICR_RECORD_TYPE,
      isDynamic: true
    });

    rec.setValue({
      fieldId: 'subsidiary',
      value: Number(subsidiaryId)
    });

    rec.setValue({
      fieldId: 'trandate',
      value: parseNsDate(row.required_icr_date)
    });

    rec.setValue({
      fieldId: 'item',
      value: Number(row.item_internal_id)
    });

    rec.setValue({
      fieldId: 'location',
      value: Number(locationId)
    });

    rec.setValue({
      fieldId: 'account',
      value: Number(accountId)
    });

    rec.setValue({
      fieldId: 'memo',
      value: `Auto-created ICR before first transaction ${row.first_transaction_number || row.first_transaction_internal_id}`
    });

    const id = rec.save({
      enableSourcing: true,
      ignoreMandatoryFields: false
    });

    log.audit({
      title: 'Auto-created Inventory Cost Revaluation',
      details: JSON.stringify({
        icrId: id,
        item: row.itemid,
        itemInternalId: row.item_internal_id,
        requiredDate: row.required_icr_date,
        firstTransaction: row.first_transaction_number,
        accountId,
        locationId,
        subsidiaryId
      })
    });

    return id;
  }

  function parseSelected(request) {
    try {
      return JSON.parse(request.parameters.custpage_selected_json || '[]');
    } catch (e) {
      return [];
    }
  }

  function processSelected(selected, mode) {
    const max = getMaxPerRun();
    const results = [];

    selected.slice(0, max).forEach(row => {
      const result = {
        itemid: row.itemid,
        item_internal_id: row.item_internal_id,
        required_icr_date: row.required_icr_date,
        first_transaction_number: row.first_transaction_number,
        status: '',
        icr_id: '',
        message: ''
      };

      try {
        if (SKIP_ITEM_IDS[Number(row.item_internal_id)]) {
          result.status = 'SKIPPED';
          result.message = `Skipped manually: ${SKIP_ITEM_IDS[Number(row.item_internal_id)]}`;
          results.push(result);
          return;
        }

        if (!row.item_internal_id || !row.required_icr_date) {
          throw new Error('Missing item internal ID or required ICR date.');
        }

        if (mode === 'PREVIEW') {
          result.status = 'PREVIEW ONLY';
          result.message = 'No transaction created.';
        } else if (mode === 'CONFIRM') {
          const icrId = createIcr(row);
          result.status = 'CREATED';
          result.icr_id = icrId;
          result.message = `Created ICR internal ID ${icrId}`;
        } else {
          result.status = 'SKIPPED';
          result.message = 'Invalid mode.';
        }

      } catch (e) {
        result.status = 'FAILED';
        result.message = String(e.message || e);

        log.error({
          title: 'Failed to auto-create ICR',
          details: JSON.stringify({
            row,
            error: e.message || e
          })
        });
      }

      results.push(result);
    });

    if (selected.length > max) {
      results.push({
        itemid: '',
        item_internal_id: '',
        required_icr_date: '',
        first_transaction_number: '',
        status: 'LIMIT REACHED',
        icr_id: '',
        message: `Only ${max} records processed this run. ${selected.length - max} selected rows were not processed.`
      });
    }

    return results;
  }

  function buildResultsHtml(results) {
    if (!results || !results.length) return '';

    let html = `
      <h3>Processing Results</h3>
      <table class="icr-table">
        <tr>
          <th>Status</th>
          <th>Item</th>
          <th>Required ICR Date</th>
          <th>First Transaction</th>
          <th>Created ICR ID</th>
          <th>Message</th>
        </tr>
    `;

    results.forEach(r => {
      const cls = r.status === 'CREATED'
        ? 'ok'
        : r.status === 'FAILED'
          ? 'bad'
          : 'warn';

      html += `
        <tr class="${cls}">
          <td>${esc(r.status)}</td>
          <td>${esc(r.itemid)}<br/>${esc(r.item_internal_id)}</td>
          <td>${esc(r.required_icr_date)}</td>
          <td>${esc(r.first_transaction_number)}</td>
          <td>${esc(r.icr_id)}</td>
          <td>${esc(r.message)}</td>
        </tr>
      `;
    });

    html += `</table>`;
    return html;
  }

  function buildMainHtml(rows, resultsHtml) {
    let html = `
      <style>
        .icr-wrap { font-family: Arial, sans-serif; font-size: 13px; }
        .icr-summary { margin: 14px 0; line-height: 1.6; }
        .icr-btn {
          display: inline-block;
          padding: 8px 12px;
          margin-right: 8px;
          border-radius: 4px;
          border: 0;
          background: #1a73e8;
          color: white;
          font-weight: bold;
          cursor: pointer;
        }
        .icr-btn-red { background: #b00020; }
        .icr-btn-gray { background: #666; }
        .icr-table { border-collapse: collapse; width: 100%; margin-top: 12px; }
        .icr-table th { background: #ddd; border: 1px solid #ccc; padding: 7px; text-align: left; }
        .icr-table td { border: 1px solid #ddd; padding: 7px; vertical-align: top; }
        .nonposting { background: #fffbe6; }
        .realissue { background: #ffe5e5; }
        .ok { background: #e6ffed; }
        .bad { background: #ffe5e5; color: #b00020; font-weight: bold; }
        .warn { background: #fffbe6; }
        .pill { display: inline-block; padding: 3px 7px; border-radius: 12px; font-size: 12px; font-weight: bold; }
        .pill-yellow { background: #fff2b8; color: #6b4e00; }
        .pill-red { background: #ffd6d6; color: #9b0000; }
      </style>

      <div class="icr-wrap">
        <div class="icr-summary">
          <b>Total failures available:</b> ${rows.length}<br/>
          <b>Max records per confirm run:</b> ${getMaxPerRun()}<br/>
          <b>Adjustment Account:</b> ${esc(getParam(PARAM_ACCOUNT))}<br/>
          <b>Location:</b> ${esc(getParam(PARAM_LOCATION))}<br/>
          <b>Subsidiary:</b> ${esc(getParam(PARAM_SUBSIDIARY))}<br/><br/>

          <span style="color:#b00020;font-weight:bold;">
            Confirm mode creates real Inventory Cost Revaluation transactions.
          </span>
        </div>

        ${resultsHtml || ''}

        <button type="button" class="icr-btn icr-btn-gray" onclick="toggleAll(true)">Select All Visible</button>
        <button type="button" class="icr-btn icr-btn-gray" onclick="toggleAll(false)">Clear All</button>
        <button type="button" class="icr-btn" onclick="submitIcr('PREVIEW')">Preview Selected</button>
        <button type="button" class="icr-btn icr-btn-red" onclick="submitIcr('CONFIRM')">Confirm Create Selected</button>

        <table class="icr-table">
          <tr>
            <th>Select</th>
            <th>Issue</th>
            <th>Item</th>
            <th>Required ICR Date</th>
            <th>First Transaction</th>
            <th>First ICR</th>
          </tr>
    `;

    rows.slice(0, MAX_UI_ROWS).forEach(r => {
      const isReal = r.posting === 'T' || r.isinventoryaffecting === 'T';
      const rowClass = isReal ? 'realissue' : 'nonposting';
      const pill = isReal
        ? '<span class="pill pill-red">REAL ISSUE</span>'
        : '<span class="pill pill-yellow">NON-POSTING ONLY</span>';

      const isSkipped = SKIP_ITEM_IDS[Number(r.item_internal_id)];
      const skipNote = isSkipped
        ? `<br/><span style="color:#b00020;font-weight:bold;">Manual Skip: ${esc(isSkipped)}</span>`
        : '';

      html += `
        <tr class="${rowClass}">
          <td>
            <input type="checkbox" class="icr-check" data-row='${esc(JSON.stringify(r))}'>
          </td>
          <td>${pill}${skipNote}</td>
          <td>
            <b>${esc(r.itemid)}</b><br/>
            Internal ID: ${esc(r.item_internal_id)}<br/>
            ${esc(r.itemtype)}
          </td>
          <td><b>${esc(r.required_icr_date)}</b></td>
          <td>
            ${esc(r.first_transaction_date)}<br/>
            ${esc(r.first_transaction_type)} ${esc(r.first_transaction_number)}<br/>
            Posting: ${esc(r.posting)} |
            Inv Affecting: ${esc(r.isinventoryaffecting)}
          </td>
          <td>
            ${
              r.first_icr_internal_id
                ? `${esc(r.first_icr_date)}<br/>${esc(r.first_icr_number)}<br/>${esc(r.first_icr_internal_id)}`
                : '<span style="color:red;font-weight:bold;">No ICR Found</span>'
            }
          </td>
        </tr>
      `;
    });

    html += `
        </table>

        <script>
          function toggleAll(checked) {
            document.querySelectorAll('.icr-check').forEach(function(cb) {
              cb.checked = checked;
            });
          }

          function submitIcr(mode) {
            var selected = [];

            document.querySelectorAll('.icr-check:checked').forEach(function(cb) {
              selected.push(JSON.parse(cb.getAttribute('data-row')));
            });

            if (!selected.length) {
              alert('Please select at least one row.');
              return;
            }

            if (mode === 'CONFIRM') {
              var ok = confirm('This will create real Inventory Cost Revaluation transactions for selected rows. Continue?');
              if (!ok) return;
            }

            document.getElementById('custpage_action').value = mode;
            document.getElementById('custpage_selected_json').value = JSON.stringify(selected);

            document.forms[0].submit();
          }
        </script>
      </div>
    `;

    return html;
  }

  function onRequest(context) {
    let processingResults = [];

    if (context.request.method === 'POST') {
      const action = context.request.parameters.custpage_action;
      const selected = parseSelected(context.request);

      if (action === 'PREVIEW' || action === 'CONFIRM') {
        processingResults = processSelected(selected, action);
      }
    }

    const rows = getRows();

    const form = ui.createForm({
      title: 'Controlled Auto-Create Inventory Cost Revaluations'
    });

    const actionField = form.addField({
      id: 'custpage_action',
      type: ui.FieldType.TEXT,
      label: 'Action'
    });
    actionField.updateDisplayType({
      displayType: ui.FieldDisplayType.HIDDEN
    });

    const selectedField = form.addField({
      id: 'custpage_selected_json',
      type: ui.FieldType.LONGTEXT,
      label: 'Selected JSON'
    });
    selectedField.updateDisplayType({
      displayType: ui.FieldDisplayType.HIDDEN
    });

    const html = form.addField({
      id: 'custpage_html',
      type: ui.FieldType.INLINEHTML,
      label: 'ICR Creation Console'
    });

    html.defaultValue = buildMainHtml(rows, buildResultsHtml(processingResults));

    context.response.writePage(form);
  }

  return { onRequest };
});