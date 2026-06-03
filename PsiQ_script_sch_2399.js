/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * Author: Ramakrishna Ambati
 * Date: 05/06/2026
 */
define(['N/ui/serverWidget', 'N/task', 'N/url', 'N/redirect', 'N/log'], (
  serverWidget,
  task,
  url,
  redirect,
  log
) => {

  // This Suitelet links back to itself for execute/status actions. Keeping the
  // IDs in constants avoids repeating hard-coded values throughout the script.
  const SUITELET_SCRIPT_ID = 'customscript1984';
  const SUITELET_DEPLOYMENT_ID = 'customdeploy1';

  // Browser-side task history is stored in localStorage, so these limits prevent
  // the table from growing forever on a user's machine.
  const MAX_HISTORY_ROWS = 100;
  const MAX_HISTORY_DAYS = 30;

  // Scripts exposed on the dashboard. Each entry drives the Execute link, native
  // status link, metadata display, and client-side duplicate-run protection.
  const SCRIPT_LIST = [
    {
      name: 'Vendor Delivery Report',
      type: 'MAP_REDUCE',
      scriptId: 'customscript_psiq_vendor_delivery_rpt',
      deploymentId: 'customdeploy1',
      concurrencyLimit: 4
    },
    {
      name: 'Vendor Delivery Accurals Report',
      type: 'MAP_REDUCE',
      scriptId: 'customscript1986',
      deploymentId: 'customdeploy1',
      concurrencyLimit: 4
    },
    {
      name: 'One Supply Integration Sync',
      type: 'SCHEDULED',
      scriptId: 'customscript_xx1s_fetch_onhand',
      deploymentId: 'customdeploy2',
      concurrencyLimit: ''
    }
  ];

  // Suitelet entry point. Routes action requests to task submission, task-status
  // JSON, or the normal dashboard page.
  function onRequest(context) {
    try {
      const params = context.request.parameters;

      // Action used by the Execute button. It submits the selected script task and
      // redirects back with task metadata so the browser can add it to history.
      if (params.action === 'execute') {
        executeScript(context);
        return;
      }

      // Lightweight polling endpoint used by the generated client script.
      if (params.action === 'status') {
        returnStatusJson(context);
        return;
      }

      // Default page load renders the full dashboard.
      renderPage(context);

    } catch (e) {
      // Log the full error for admins and show a short message in the browser.
      log.error('Suitelet Error', e);
      context.response.write('Error: ' + e.message);
    }
  }

  // Builds the NetSuite form shell and injects all custom UI as INLINEHTML.
  function renderPage(context) {
    const form = serverWidget.createForm({
      title: 'Script Automation Dashboard'
    });

    const htmlField = form.addField({
      id: 'custpage_html',
      type: serverWidget.FieldType.INLINEHTML,
      label: 'HTML'
    });

    // The dashboard is a single self-contained HTML/CSS/JS payload.
    htmlField.defaultValue = buildHtml(context);
    context.response.writePage(form);
  }

  // Builds the full dashboard markup. Most behavior after render happens in the
  // browser so task history can persist locally per user/session.
  function buildHtml(context) {
    // These parameters are populated after a task submission redirect. The
    // browser script reads them once and inserts a new local history row.
    const newTaskId = context.request.parameters.taskid || '';
    const newScriptName = context.request.parameters.scriptname || '';
    const newScriptType = context.request.parameters.scripttype || '';
    const newScriptId = context.request.parameters.scriptid || '';
    const newDeployId = context.request.parameters.deployid || '';
    const newConcurrencyLimit = context.request.parameters.concurrencylimit || '';

    let html = '';

    // Inline styles keep this Suitelet deployable without File Cabinet assets.
    html += '<style>';
    html += '.psiq-section{margin-top:25px;width:100%;}';
    html += '.psiq-table{width:100%;border-collapse:collapse;font-size:14px;table-layout:fixed;margin-top:15px;}';
    html += '.psiq-table th{background:#e5e9f2;padding:10px;border:1px solid #ccc;text-align:left;}';
    html += '.psiq-table td{padding:10px;border:1px solid #ddd;vertical-align:middle;overflow-wrap:anywhere;word-break:break-word;}';

    html += '.row-active{background:#fff8d6;}';
    html += '.row-failed{background:#ffe5e5;}';
    html += '.row-complete{background:#f4fff4;}';

    html += '.psiq-btn{background:#0073ff;color:#fff!important;padding:8px 14px;border-radius:4px;text-decoration:none;font-weight:bold;display:inline-block;border:none;cursor:pointer;}';
    html += '.psiq-btn-disabled{background:#999;color:#fff!important;padding:8px 14px;border-radius:4px;text-decoration:none;font-weight:bold;display:inline-block;border:none;cursor:not-allowed;}';
    html += '.psiq-btn-status{background:#2f6f46;color:#fff!important;padding:8px 14px;border-radius:4px;text-decoration:none;font-weight:bold;display:inline-block;border:none;cursor:pointer;}';
    html += '.psiq-btn-red{background:#cc0000;color:#fff!important;padding:8px 14px;border-radius:4px;text-decoration:none;font-weight:bold;display:inline-block;border:none;cursor:pointer;}';
    html += '.psiq-btn-gray{background:#666;color:#fff!important;padding:8px 14px;border-radius:4px;text-decoration:none;font-weight:bold;display:inline-block;border:none;cursor:pointer;}';

    html += '.badge{padding:4px 8px;border-radius:12px;font-weight:bold;color:#fff;display:inline-block;font-size:12px;min-width:75px;text-align:center;}';
    html += '.badge-complete{background:#2e7d32;}';
    html += '.badge-running{background:#f9a825;color:#111;}';
    html += '.badge-pending{background:#1976d2;}';
    html += '.badge-failed{background:#c62828;}';
    html += '.badge-canceled{background:#555;}';
    html += '.badge-unknown{background:#777;}';

    html += '.available-execute{width:120px;}';
    html += '.available-status{width:140px;}';
    html += '.available-name{width:240px;}';
    html += '.available-type{width:130px;}';
    html += '.available-script{width:340px;}';
    html += '.available-deploy{width:240px;}';
    html += '.available-concurrency{width:130px;}';

    html += '.hist-name{width:130px;}';
    html += '.hist-type{width:90px;}';
    html += '.hist-task{width:210px;font-size:12px;line-height:1.35;}';
    html += '.hist-status{width:100px;}';
    html += '.hist-stage{width:115px;}';
    html += '.hist-progress{width:140px;}';
    html += '.hist-concurrency{width:125px;font-size:12px;line-height:1.35;}';
    html += '.hist-duration{width:95px;font-weight:bold;}';
    html += '.hist-started{width:130px;}';
    html += '.hist-checked{width:130px;}';
    html += '.hist-native{width:120px;}';
    html += '.hist-note{width:150px;}';

    html += '.psiq-bar-wrap{width:115px;max-width:115px;border:1px solid #ccc;height:16px;margin-top:4px;overflow:hidden;background:#f5f5f5;}';
    html += '.psiq-bar{height:16px;max-width:115px;}';
    html += '.bar-blue{background:#0073ff;}';
    html += '.bar-orange{background:#f9a825;}';
    html += '.bar-green{background:#2e7d32;}';

    html += '.tooltip{position:relative;}';
    html += '.tooltip:hover:after{content:attr(data-tooltip);position:absolute;left:0;top:36px;background:#333;color:#fff;padding:8px 10px;border-radius:4px;white-space:normal;width:280px;z-index:9999;font-size:12px;line-height:1.3;}';
    html += '</style>';

    // Available script table: one row per configured script in SCRIPT_LIST.
    html += '<div class="psiq-section">';
    html += '<h3>Available Scripts</h3>';
    html += '<table class="psiq-table">';
    html += '<tr>';
    html += '<th class="available-execute">Execute</th>';
    html += '<th class="available-status">Native Status</th>';
    html += '<th class="available-name">Name</th>';
    html += '<th class="available-type">Type</th>';
    html += '<th class="available-script">Script ID</th>';
    html += '<th class="available-deploy">Deployment ID</th>';
    html += '<th class="available-concurrency">Concurrency</th>';
    html += '</tr>';

    for (let i = 0; i < SCRIPT_LIST.length; i++) {
      const s = SCRIPT_LIST[i];

      // Generate a self-link that submits this configured script. A timestamp is
      // included to avoid stale browser caching on repeated clicks.
      const executeUrl = url.resolveScript({
        scriptId: SUITELET_SCRIPT_ID,
        deploymentId: SUITELET_DEPLOYMENT_ID,
        params: {
          action: 'execute',
          index: String(i),
          ts: String(new Date().getTime())
        }
      });

      html += '<tr>';
      html += '<td class="available-execute">';
      // Data attributes let the browser-side duplicate-run guard match the button
      // to local task history for the same script/deployment.
      html += '<a class="psiq-btn execute-btn tooltip" ';
      html += 'data-scriptid="' + escapeHtml(s.scriptId) + '" ';
      html += 'data-deployid="' + escapeHtml(s.deploymentId) + '" ';
      html += 'data-tooltip="Click to submit this script deployment." ';
      html += 'href="' + executeUrl + '">Execute</a>';
      html += '</td>';

      html += '<td class="available-status"><a class="psiq-btn-status" target="_blank" href="' + getNativeStatusUrl(s.type) + '">View Status</a></td>';
      html += '<td class="available-name">' + escapeHtml(s.name) + '</td>';
      html += '<td class="available-type">' + escapeHtml(s.type) + '</td>';
      html += '<td class="available-script">' + escapeHtml(s.scriptId) + '</td>';
      html += '<td class="available-deploy">' + escapeHtml(s.deploymentId) + '</td>';
      html += '<td class="available-concurrency">' + escapeHtml(s.concurrencyLimit || 'N/A') + '</td>';
      html += '</tr>';
    }

    html += '</table>';
    html += '</div>';

    // History table starts empty; the browser fills it from localStorage and then
    // updates it as task polling responses arrive.
    html += '<div class="psiq-section">';
    html += '<h3>Running / Recent Tasks</h3>';
    html += '<button class="psiq-btn-gray" onclick="exportHistoryCsv()">Export History CSV</button> ';
    html += '<button class="psiq-btn-red" onclick="clearHistory()">Clear History</button>';

    html += '<table class="psiq-table" id="historyTable">';
    html += '<tr>';
    html += '<th class="hist-name">Script Name</th>';
    html += '<th class="hist-type">Type</th>';
    html += '<th class="hist-task">Task ID</th>';
    html += '<th class="hist-status">Status</th>';
    html += '<th class="hist-stage">Stage</th>';
    html += '<th class="hist-progress">Progress</th>';
    html += '<th class="hist-concurrency">Concurrency</th>';
    html += '<th class="hist-duration">Duration</th>';
    html += '<th class="hist-started">Started</th>';
    html += '<th class="hist-checked">Last Checked</th>';
    html += '<th class="hist-native">Native Status</th>';
    html += '<th class="hist-note">Error / Notes</th>';
    html += '</tr>';
    html += '</table>';
    html += '</div>';

    // Status endpoint URL used by the polling code below.
    const statusUrl = url.resolveScript({
      scriptId: SUITELET_SCRIPT_ID,
      deploymentId: SUITELET_DEPLOYMENT_ID,
      params: { action: 'status' }
    });

    html += '<script>';
    // Server-generated values passed into the client script.
    html += 'var STATUS_URL = "' + statusUrl + '";';
    html += 'var NEW_TASK_ID = "' + escapeJs(newTaskId) + '";';
    html += 'var NEW_SCRIPT_NAME = "' + escapeJs(newScriptName) + '";';
    html += 'var NEW_SCRIPT_TYPE = "' + escapeJs(newScriptType) + '";';
    html += 'var NEW_SCRIPT_ID = "' + escapeJs(newScriptId) + '";';
    html += 'var NEW_DEPLOY_ID = "' + escapeJs(newDeployId) + '";';
    html += 'var NEW_CONCURRENCY_LIMIT = "' + escapeJs(newConcurrencyLimit) + '";';
    html += 'var MAX_HISTORY_ROWS = ' + MAX_HISTORY_ROWS + ';';
    html += 'var MAX_HISTORY_DAYS = ' + MAX_HISTORY_DAYS + ';';
    html += 'var MAP_REDUCE_STATUS_URL = "/app/common/scripting/mapreducescriptstatus.nl";';
    html += 'var SCHEDULED_STATUS_URL = "/app/common/scripting/scriptstatus.nl";';

    html += `
      // NetSuite task statuses that should stop polling and re-enable Execute.
      function isTerminalStatus(status) {
        return status === 'COMPLETE' ||
               status === 'FAILED' ||
               status === 'CANCELED' ||
               status === 'ERROR';
      }

      // Reads local task history. Corrupt JSON is treated as empty history.
      function getHistory() {
        try {
          return JSON.parse(localStorage.getItem('psiq_script_task_history') || '[]');
        } catch (e) {
          return [];
        }
      }

      // Persists task history in the browser. This is intentionally local to the
      // current user/browser and is not written to a NetSuite custom record.
      function saveHistory(rows) {
        localStorage.setItem('psiq_script_task_history', JSON.stringify(rows));
      }

      // Prunes old and excess history rows before rendering or polling.
      function cleanupHistory() {
        var rows = getHistory();
        var cutoff = new Date().getTime() - (MAX_HISTORY_DAYS * 24 * 60 * 60 * 1000);

        rows = rows.filter(function(r) {
          // Preserve legacy rows without a timestamp rather than deleting unknown
          // user history.
          if (!r.startedAtMs) return true;
          return Number(r.startedAtMs) >= cutoff;
        });

        // Newest submissions should stay at the top.
        rows.sort(function(a, b) {
          return Number(b.startedAtMs || 0) - Number(a.startedAtMs || 0);
        });

        if (rows.length > MAX_HISTORY_ROWS) {
          rows = rows.slice(0, MAX_HISTORY_ROWS);
        }

        saveHistory(rows);
      }

      // Adds the task submitted by the current redirect to local history.
      function addNewTaskIfNeeded() {
        if (!NEW_TASK_ID) return;

        var rows = getHistory();
        var exists = rows.some(function(r) {
          return r.taskId === NEW_TASK_ID;
        });

        if (!exists) {
          var now = new Date();

          // New rows start as SUBMITTED until the status endpoint reports a more
          // specific NetSuite status.
          rows.unshift({
            scriptName: NEW_SCRIPT_NAME || '',
            scriptType: NEW_SCRIPT_TYPE || '',
            scriptId: NEW_SCRIPT_ID || '',
            deploymentId: NEW_DEPLOY_ID || '',
            concurrencyLimit: NEW_CONCURRENCY_LIMIT || '',
            taskId: NEW_TASK_ID,
            status: 'SUBMITTED',
            stage: '',
            percent: '',
            startedAt: now.toLocaleString(),
            startedAtMs: now.getTime(),
            lastChecked: '',
            lastCheckedMs: '',
            completedAtMs: '',
            durationMs: '',
            note: ''
          });

          saveHistory(rows);
        }
      }

      // Finds a non-terminal task for the same script deployment.
      function getRunningTaskForDeployment(scriptId, deploymentId) {
        var rows = getHistory();

        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];

          if (
            r.scriptId === scriptId &&
            r.deploymentId === deploymentId &&
            !isTerminalStatus(r.status)
          ) {
            return r;
          }
        }

        return null;
      }

      // Counts active local-history tasks for the same deployment. This is a
      // dashboard-side estimate, not a NetSuite account-wide concurrency count.
      function getActiveLocalConcurrency(scriptId, deploymentId) {
        var rows = getHistory();

        return rows.filter(function(r) {
          return r.scriptId === scriptId &&
                 r.deploymentId === deploymentId &&
                 !isTerminalStatus(r.status);
        }).length;
      }

      // Builds concurrency display text for history rows.
      function getConcurrencyText(row) {
        if (row.scriptType !== 'MAP_REDUCE') {
          return 'N/A';
        }

        var limit = row.concurrencyLimit || '';
        var activeLocal = getActiveLocalConcurrency(row.scriptId, row.deploymentId);

        var html = '';
        html += 'Limit: ' + htmlEscape(limit || 'not set');
        html += '<br>Active local: ' + htmlEscape(activeLocal);

        return html;
      }

      // Enables/disables Execute buttons based on local non-terminal task history.
      function updateExecuteButtons() {
        var buttons = document.querySelectorAll('.execute-btn');

        buttons.forEach(function(btn) {
          var scriptId = btn.getAttribute('data-scriptid');
          var deploymentId = btn.getAttribute('data-deployid');
          var runningTask = getRunningTaskForDeployment(scriptId, deploymentId);
          var originalHref = btn.getAttribute('data-original-href');

          if (runningTask) {
            // Disable the button while local history says this deployment is
            // already running.
            btn.className = 'psiq-btn-disabled execute-btn tooltip';
            btn.innerHTML = 'Running';
            btn.setAttribute('data-disabled', 'T');
            btn.removeAttribute('href');
            btn.setAttribute(
              'data-tooltip',
              'Already running. Task: ' + runningTask.taskId + ' | Status: ' + runningTask.status
            );
          } else {
            btn.className = 'psiq-btn execute-btn tooltip';
            btn.innerHTML = 'Execute';
            btn.setAttribute('data-disabled', 'F');

            if (originalHref) {
              // Restore the original self-link when the deployment is no longer
              // active in local history.
              btn.setAttribute('href', originalHref);
            }

            btn.setAttribute('data-tooltip', 'Click to submit this script deployment.');
          }
        });
      }

      // Attaches click protection to Execute buttons. This prevents double-clicks
      // and duplicate local submissions before the page redirects.
      function protectExecuteButtons() {
        var buttons = document.querySelectorAll('.execute-btn');

        buttons.forEach(function(btn) {
          var originalHref = btn.getAttribute('href');
          btn.setAttribute('data-original-href', originalHref || '');

          btn.onclick = function(e) {
            var scriptId = btn.getAttribute('data-scriptid');
            var deploymentId = btn.getAttribute('data-deployid');
            var runningTask = getRunningTaskForDeployment(scriptId, deploymentId);

            if (runningTask) {
              e.preventDefault();
              alert('This deployment is already running. Task ID: ' + runningTask.taskId);
              return false;
            }

            var href = btn.getAttribute('data-original-href');

            if (href) {
              // Optimistically disable the button immediately so users see that
              // the submission is in progress.
              btn.className = 'psiq-btn-disabled execute-btn tooltip';
              btn.innerHTML = 'Submitting...';
              btn.setAttribute('data-tooltip', 'Submitting request...');
              btn.removeAttribute('href');
              window.location.href = href;
            }

            e.preventDefault();
            return false;
          };
        });
      }

      // Converts a raw NetSuite task status into a colored badge. The badge
      // keeps the table easy to scan when many scripts are being monitored.
      function getBadgeHtml(status) {
        var cls = 'badge-unknown';
        var label = status || 'UNKNOWN';

        // Match known task states to CSS classes defined in the inline style
        // block above.
        if (status === 'COMPLETE') cls = 'badge-complete';
        else if (status === 'PENDING' || status === 'SUBMITTED') cls = 'badge-pending';
        else if (status === 'PROCESSING' || status === 'RUNNING') cls = 'badge-running';
        else if (status === 'FAILED' || status === 'ERROR') cls = 'badge-failed';
        else if (status === 'CANCELED') cls = 'badge-canceled';
        else if (!isTerminalStatus(status)) cls = 'badge-running';

        // Escape the label before writing it into the DOM because task status
        // values are treated as display text.
        return '<span class="badge ' + cls + '">' + htmlEscape(label) + '</span>';
      }

      // Returns a row-level class so complete, failed, and active executions are
      // visually distinct in the browser history table.
      function getRowClass(status) {
        if (status === 'COMPLETE') return 'row-complete';
        if (status === 'FAILED' || status === 'ERROR') return 'row-failed';
        if (!isTerminalStatus(status)) return 'row-active';
        return '';
      }

      // Chooses a progress-bar color based on completion percentage.
      function getProgressBarClass(percent) {
        var pct = Number(percent || 0);

        if (pct >= 100) return 'bar-green';
        if (pct >= 50) return 'bar-orange';
        return 'bar-blue';
      }

      // Formats a millisecond duration into a compact human-readable value.
      function formatDuration(ms) {
        ms = Number(ms || 0);

        // Empty string keeps the duration cell clean before timing data exists.
        if (ms <= 0) return '';

        var totalSeconds = Math.floor(ms / 1000);
        var hours = Math.floor(totalSeconds / 3600);
        var minutes = Math.floor((totalSeconds % 3600) / 60);
        var seconds = totalSeconds % 60;

        // Include only the largest relevant units so the table stays compact.
        if (hours > 0) return hours + 'h ' + minutes + 'm ' + seconds + 's';
        if (minutes > 0) return minutes + 'm ' + seconds + 's';

        return seconds + 's';
      }

      // Calculates elapsed runtime for a history row. Active rows use the
      // current time; terminal rows use the recorded completion/check time.
      function getDurationText(row) {
        var startMs = Number(row.startedAtMs || 0);

        if (!startMs) return '';

        var endMs;

        if (isTerminalStatus(row.status)) {
          // Prefer the completion timestamp, then the last status check, then
          // now as a final fallback.
          endMs = Number(row.completedAtMs || row.lastCheckedMs || new Date().getTime());
        } else {
          endMs = new Date().getTime();
        }

        return formatDuration(endMs - startMs);
      }

      // Rebuilds the local task-history table from localStorage data.
      function renderHistory() {
        var rows = getHistory();
        var table = document.getElementById('historyTable');

        // Preserve the header row and remove any previously rendered body rows.
        while (table.rows.length > 1) {
          table.deleteRow(1);
        }

        if (rows.length === 0) {
          // Show an explicit empty state so the dashboard does not look broken
          // before the first task submission.
          var empty = table.insertRow(-1);
          var cell = empty.insertCell(0);
          cell.colSpan = 12;
          cell.innerHTML = 'No task history yet.';
          updateExecuteButtons();
          return;
        }

        rows.forEach(function(r) {
          var tr = table.insertRow(-1);
          var rowClass = getRowClass(r.status);

          if (rowClass) {
            tr.className = rowClass;
          }

          // Write each cell with escaped text except for controlled HTML
          // fragments such as badges, progress bars, and internal links.
          tr.insertCell(0).outerHTML = '<td class="hist-name">' + htmlEscape(r.scriptName) + '</td>';
          tr.insertCell(1).outerHTML = '<td class="hist-type">' + htmlEscape(r.scriptType) + '</td>';
          tr.insertCell(2).outerHTML = '<td class="hist-task">' + htmlEscape(r.taskId) + '</td>';
          tr.insertCell(3).outerHTML = '<td class="hist-status">' + getBadgeHtml(r.status) + '</td>';
          tr.insertCell(4).outerHTML = '<td class="hist-stage">' + htmlEscape(r.stage || '') + '</td>';

          var pct = r.percent || '';
          var progressHtml = '';

          if (pct !== '') {
            var barClass = getProgressBarClass(pct);

            // NetSuite returns percentage for task types that support it. The
            // visual bar is omitted when no percentage is available.
            progressHtml =
              '<div>' + htmlEscape(pct) + '%</div>' +
              '<div class="psiq-bar-wrap">' +
              '<div class="psiq-bar ' + barClass + '" style="width:' + htmlEscape(pct) + '%;"></div>' +
              '</div>';
          }

          tr.insertCell(5).outerHTML = '<td class="hist-progress">' + progressHtml + '</td>';
          tr.insertCell(6).outerHTML = '<td class="hist-concurrency">' + getConcurrencyText(r) + '</td>';
          tr.insertCell(7).outerHTML = '<td class="hist-duration">' + htmlEscape(getDurationText(r)) + '</td>';
          tr.insertCell(8).outerHTML = '<td class="hist-started">' + htmlEscape(r.startedAt || '') + '</td>';
          tr.insertCell(9).outerHTML = '<td class="hist-checked">' + htmlEscape(r.lastChecked || '') + '</td>';

          var nativeUrl = getNativeStatusUrlClient(r.scriptType);
          var nativeLink = '<a class="psiq-btn-status" target="_blank" href="' + nativeUrl + '">View Status</a>';

          // The native status link points to the general NetSuite status page
          // for the script type, while the task ID cell identifies the exact run.
          tr.insertCell(10).outerHTML = '<td class="hist-native">' + nativeLink + '</td>';
          tr.insertCell(11).outerHTML = '<td class="hist-note">' + htmlEscape(r.note || '') + '</td>';
        });

        // Re-evaluate Execute button state after the table reflects latest data.
        updateExecuteButtons();
      }

      // Polls this Suitelet's JSON endpoint for all locally active task IDs and
      // merges the latest NetSuite statuses back into browser history.
      function refreshStatuses() {
        var rows = getHistory();

        // Only non-terminal rows need polling.
        var activeRows = rows.filter(function(r) {
          return !isTerminalStatus(r.status);
        });

        if (activeRows.length === 0) {
          // Even when nothing is active, cleanup may trim expired or excess
          // history entries.
          cleanupHistory();
          renderHistory();
          return;
        }

        // The server endpoint accepts comma-separated task IDs.
        var ids = activeRows.map(function(r) {
          return r.taskId;
        }).join(',');

        fetch(STATUS_URL + '&taskids=' + encodeURIComponent(ids))
          .then(function(res) {
            return res.json();
          })
          .then(function(data) {
            var statusMap = {};

            // Convert the array response into a lookup table for quick merging.
            data.results.forEach(function(s) {
              statusMap[s.taskId] = s;
            });

            var now = new Date();
            var nowMs = now.getTime();
            var nowText = now.toLocaleString();

            rows.forEach(function(r) {
              var s = statusMap[r.taskId];
              if (!s) return;

              // Capture the previous terminal state so completion time is only
              // stamped once, at the transition from active to terminal.
              var wasTerminal = isTerminalStatus(r.status);

              // Keep existing values when NetSuite does not return a field for a
              // particular task type/status combination.
              r.status = s.status || r.status;
              r.stage = s.stage || r.stage || '';
              r.percent = s.percent || r.percent || '';
              r.lastChecked = nowText;
              r.lastCheckedMs = nowMs;
              r.note = s.note || '';

              if (!wasTerminal && isTerminalStatus(r.status)) {
                r.completedAtMs = nowMs;
              }

              if (r.startedAtMs) {
                // Store raw duration milliseconds so CSV export and future
                // display logic can reuse the exact same elapsed time.
                var durationEnd = isTerminalStatus(r.status)
                  ? Number(r.completedAtMs || nowMs)
                  : nowMs;

                r.durationMs = durationEnd - Number(r.startedAtMs);
              }
            });

            saveHistory(rows);
            cleanupHistory();
            renderHistory();

            // Continue polling while any local task remains active.
            var stillActive = getHistory().some(function(r) {
              return !isTerminalStatus(r.status);
            });

            if (stillActive) {
              setTimeout(refreshStatuses, 5000);
            }
          })
          .catch(function(e) {
            // Surface polling errors in active rows instead of silently failing.
            rows.forEach(function(r) {
              if (!isTerminalStatus(r.status)) {
                r.note = 'Status refresh error: ' + e.message;
              }
            });

            saveHistory(rows);
            renderHistory();

            // Retry after a short delay; transient Suitelet or network errors
            // should not permanently stop the dashboard from updating.
            setTimeout(refreshStatuses, 5000);
          });
      }

      // Client-side mirror of getNativeStatusUrl so history rows can build links
      // without another server call.
      function getNativeStatusUrlClient(scriptType) {
        if (scriptType === 'MAP_REDUCE') {
          return MAP_REDUCE_STATUS_URL;
        }

        return SCHEDULED_STATUS_URL;
      }

      // Downloads the browser-local execution history as a CSV file.
      function exportHistoryCsv() {
        var rows = getHistory();
        var csv = [];

        // Header row intentionally includes both script metadata and runtime
        // values so the exported file can be reviewed without the dashboard.
        csv.push([
          'Script Name',
          'Type',
          'Script ID',
          'Deployment ID',
          'Concurrency Limit',
          'Active Local Concurrency',
          'Task ID',
          'Status',
          'Stage',
          'Progress',
          'Duration',
          'Started',
          'Last Checked',
          'Native Status URL',
          'Error / Notes'
        ].join(','));

        rows.forEach(function(r) {
          // csvEscape handles commas, quotes, and newlines for each cell.
          csv.push([
            csvEscape(r.scriptName),
            csvEscape(r.scriptType),
            csvEscape(r.scriptId),
            csvEscape(r.deploymentId),
            csvEscape(r.concurrencyLimit),
            csvEscape(getActiveLocalConcurrency(r.scriptId, r.deploymentId)),
            csvEscape(r.taskId),
            csvEscape(r.status),
            csvEscape(r.stage),
            csvEscape(r.percent),
            csvEscape(getDurationText(r)),
            csvEscape(r.startedAt),
            csvEscape(r.lastChecked),
            csvEscape(getNativeStatusUrlClient(r.scriptType)),
            csvEscape(r.note)
          ].join(','));
        });

        // Use a Blob URL so the export is generated entirely in the browser.
        var blob = new Blob([csv.join('\\n')], { type: 'text/csv;charset=utf-8;' });
        var link = document.createElement('a');

        link.href = URL.createObjectURL(blob);
        link.download = 'script_execution_history.csv';

        // Temporarily attach the anchor because some browsers require the link
        // to be in the document before click() will start a download.
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }

      // Clears only this dashboard's localStorage history key after user
      // confirmation. NetSuite task records themselves are not changed.
      function clearHistory() {
        if (confirm('Clear local execution history?')) {
          localStorage.removeItem('psiq_script_task_history');
          renderHistory();
        }
      }

      // Escapes text before inserting it into HTML strings.
      function htmlEscape(value) {
        return String(value || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      }

      // Escapes one value for CSV output.
      function csvEscape(value) {
        value = String(value || '');

        // Values containing CSV control characters must be quoted, and embedded
        // quotes are doubled per standard CSV rules.
        if (value.indexOf(',') >= 0 || value.indexOf('"') >= 0 || value.indexOf('\\n') >= 0) {
          value = '"' + value.replace(/"/g, '""') + '"';
        }

        return value;
      }

      // Initialization order matters: clean old history, capture the newly
      // redirected task, bind button protection, then render and start polling.
      cleanupHistory();
      addNewTaskIfNeeded();
      cleanupHistory();
      protectExecuteButtons();
      renderHistory();
      refreshStatuses();

      // Re-render once per second so active durations tick even between status
      // polling responses.
      setInterval(function() {
        renderHistory();
      }, 1000);
    `;

    html += '</script>';

    return html;
  }

  // Submits the selected SCRIPT_LIST entry as a NetSuite background task and
  // redirects back to the dashboard with enough metadata to add a history row.
  function executeScript(context) {
    // The Execute link passes a zero-based index instead of all script details,
    // keeping the URL smaller and forcing the server to use trusted config.
    const index = Number(context.request.parameters.index);
    const s = SCRIPT_LIST[index];

    // Guard against malformed URLs or stale buttons that reference an invalid
    // entry.
    if (!s) {
      throw new Error('Invalid script selected.');
    }

    let scriptTask;

    // Create a task with the correct NetSuite TaskType for the configured
    // script category.
    if (s.type === 'MAP_REDUCE') {
      scriptTask = task.create({
        taskType: task.TaskType.MAP_REDUCE,
        scriptId: s.scriptId,
        deploymentId: s.deploymentId
      });

    } else if (s.type === 'SCHEDULED') {
      scriptTask = task.create({
        taskType: task.TaskType.SCHEDULED_SCRIPT,
        scriptId: s.scriptId,
        deploymentId: s.deploymentId
      });

    } else {
      // Fail loudly for unsupported configuration values so an administrator
      // can correct SCRIPT_LIST rather than submitting an unexpected task type.
      throw new Error('Unsupported script type: ' + s.type);
    }

    // submit() returns the NetSuite task ID used later by task.checkStatus().
    const taskId = scriptTask.submit();

    // Redirect instead of writing HTML directly to avoid browser resubmission
    // prompts on refresh and to let the GET page render the new task state.
    redirect.toSuitelet({
      scriptId: SUITELET_SCRIPT_ID,
      deploymentId: SUITELET_DEPLOYMENT_ID,
      parameters: {
        // These values are consumed by addNewTaskIfNeeded() in the inline client
        // script and then stored in browser localStorage.
        taskid: taskId,
        scriptname: s.name,
        scripttype: s.type,
        scriptid: s.scriptId,
        deployid: s.deploymentId,
        concurrencylimit: s.concurrencyLimit || '',
        // Timestamp makes the redirect URL unique enough to avoid browser/cache
        // confusion after repeated submissions.
        ts: String(new Date().getTime())
      }
    });
  }

  // Returns task status information as JSON for the dashboard polling loop.
  function returnStatusJson(context) {
    // Client sends task IDs as a comma-separated list to minimize requests.
    const taskIdsText = context.request.parameters.taskids || '';

    // Drop blank values that may appear from trailing commas or empty input.
    const taskIds = taskIdsText.split(',').filter(function(id) {
      return id && id.trim();
    });

    const results = [];

    // Check each task independently so one failed lookup does not prevent other
    // task statuses from being returned.
    for (let i = 0; i < taskIds.length; i++) {
      results.push(getTaskStatus(taskIds[i]));
    }

    // Tell the browser fetch() call to parse this response as JSON.
    context.response.setHeader({
      name: 'Content-Type',
      value: 'application/json'
    });

    context.response.write(JSON.stringify({
      results: results
    }));
  }

  // Wraps task.checkStatus() and normalizes different NetSuite status object
  // shapes into the fields expected by the client table.
  function getTaskStatus(taskId) {
    // Default object shape keeps the JSON contract stable even when NetSuite
    // cannot find or inspect the task.
    const result = {
      taskId: taskId,
      status: 'Unknown',
      stage: '',
      percent: '',
      note: ''
    };

    try {
      // NetSuite looks up task status by the ID returned from scriptTask.submit().
      const statusObj = task.checkStatus({
        taskId: taskId
      });

      // status is the main lifecycle value: PENDING, PROCESSING, COMPLETE, etc.
      result.status = statusObj.status || 'Unknown';

      // Map/Reduce status objects may expose percentage through this method.
      if (typeof statusObj.getPercentageCompleted === 'function') {
        const pct = statusObj.getPercentageCompleted();

        if (pct !== null && pct !== undefined && pct !== '') {
          // Round to an integer for compact progress-bar display.
          result.percent = String(Math.round(Number(pct)));
        }
      }

      // Some complete statuses do not return a percentage, so the dashboard
      // fills in 100 to show a completed progress bar.
      if (result.status === 'COMPLETE' && result.percent === '') {
        result.percent = '100';
      }

      // NetSuite exposes stage/current stage differently across task types and
      // platform versions, so check all known shapes before falling back.
      if (statusObj.stage) {
        result.stage = String(statusObj.stage);
      } else if (statusObj.currentStage) {
        result.stage = String(statusObj.currentStage);
      } else if (typeof statusObj.getCurrentStage === 'function') {
        result.stage = String(statusObj.getCurrentStage() || '');
      } else {
        // Scheduled scripts and some task states do not expose a native stage.
        result.stage = inferStage(result.status, result.percent);
      }

    } catch (e) {
      // Return the error inside the normal JSON result so the browser can show
      // it in the Notes column without breaking the whole polling response.
      result.status = 'ERROR';
      result.note = e.message || String(e);
    }

    return result;
  }

  // Returns the built-in NetSuite status page for the requested script type.
  function getNativeStatusUrl(scriptType) {
    if (scriptType === 'MAP_REDUCE') {
      return '/app/common/scripting/mapreducescriptstatus.nl';
    }

    return '/app/common/scripting/scriptstatus.nl';
  }

  // Provides friendly stage text when NetSuite does not expose a specific
  // current stage for a task.
  function inferStage(statusText, percentText) {
    // Terminal and waiting states can be named directly from status.
    if (statusText === 'PENDING') return 'Pending';
    if (statusText === 'COMPLETE') return 'Complete';
    if (statusText === 'FAILED') return 'Failed';
    if (statusText === 'CANCELED') return 'Canceled';

    const pct = Number(percentText || 0);

    // For Map/Reduce jobs, percentage is a rough signal of which phase is most
    // likely underway.
    if (pct > 0 && pct < 70) return 'Map/Reduce Running';
    if (pct >= 70 && pct < 100) return 'Reduce/Summarize Running';
    if (pct === 100) return 'Summarize/Complete';

    return 'Running';
  }

  // Escapes server-side values before interpolating them into inline HTML.
  function escapeHtml(v) {
    return String(v || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Escapes server-side values before interpolating them into quoted JavaScript
  // literals inside the generated HTML.
  function escapeJs(v) {
    return String(v || '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');
  }

  // Expose the Suitelet entry point to NetSuite.
  return {
    onRequest: onRequest
  };
});
