/**
 * NetSuite Suitelet: Employee Last Login Monitor
 *
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * Ramakrishna Ambati
 * Date : May/27/2026
 */
define(['N/ui/serverWidget', 'N/search', 'N/runtime', 'N/url', 'N/format'], (
  serverWidget,
  search,
  runtime,
  url,
  format
) => {
  const CONFIG = {
    dashboardTitle: 'Employee Last Login Monitor',
    developedBy: 'Rama Ambati',
    version: '1.6.32',
    developerTitle: 'NetSuite Administrator',
    developerEmployeeNames: ['Rama Ambati', 'Ramakrishna Ambati'],
    developerEmployeeEmails: ['rambati@psiquantum.com'],
    allowedAccounts: ['5775522', '5775522_SB1', '5775522_SB2'],
    pageSize: 1000,
    summaryRowLimit: 10000,
    todaySummaryRowLimit: 50000,
    monthlySummaryRowLimit: 50000,
    staleDaysDefault: 90,
    todayRoleLimit: 60,
    monthlyChartMonthsDefault: 12,
    monthlyChartRoleLimit: 5,
    monthlyRoleLimit: 60,
    chartRolePrefix: 'psiq',
    chartExtraRoles: ['administrator'],
    loginAuditJoin: 'loginaudittrail'
  };

  function onRequest(context) {
    assertAllowedAccount();

    const request = context.request;
    const response = context.response;
    const filters = normalizeFilters(request.parameters || {});
    const form = serverWidget.createForm({ title: CONFIG.dashboardTitle });

    addFilterFields(form, filters);

    const htmlField = form.addField({
      id: 'custpage_login_html',
      label: 'Employee Last Login',
      type: serverWidget.FieldType.INLINEHTML
    });
    htmlField.updateLayoutType({ layoutType: serverWidget.FieldLayoutType.OUTSIDEBELOW });
    htmlField.updateBreakType({ breakType: serverWidget.FieldBreakType.STARTROW });

    try {
      htmlField.defaultValue = buildHtml(getEmployeeLoginData(filters), filters);
    } catch (e) {
      log.error({ title: 'Employee last login dashboard failed', details: e });
      htmlField.defaultValue = buildErrorHtml(e);
    }

    response.writePage(form);
  }

  function assertAllowedAccount() {
    const allowedAccounts = CONFIG.allowedAccounts || [];

    if (allowedAccounts.length && allowedAccounts.indexOf(runtime.accountId) < 0) {
      throw Error('Unauthorized account');
    }
  }

  function addFilterFields(form, filters) {
    form.addFieldGroup({ id: 'custpage_filters', label: 'Filters' });

    const employeeText = form.addField({
      id: 'custpage_employee_text',
      type: serverWidget.FieldType.TEXT,
      label: 'Employee / Email Contains',
      container: 'custpage_filters'
    });
    employeeText.defaultValue = filters.employeeText;

    const roleText = form.addField({
      id: 'custpage_role_text',
      type: serverWidget.FieldType.TEXT,
      label: 'Role Contains',
      container: 'custpage_filters'
    });
    roleText.defaultValue = filters.roleText;

    const staleDays = form.addField({
      id: 'custpage_stale_days',
      type: serverWidget.FieldType.INTEGER,
      label: 'Stale After Days',
      container: 'custpage_filters'
    });
    staleDays.defaultValue = String(filters.staleDays);

    const chartMonths = form.addField({
      id: 'custpage_chart_months',
      type: serverWidget.FieldType.INTEGER,
      label: 'Monthly Chart Months',
      container: 'custpage_filters'
    });
    chartMonths.defaultValue = String(filters.chartMonths);

    const loginAccessOnly = form.addField({
      id: 'custpage_login_access_only',
      type: serverWidget.FieldType.CHECKBOX,
      label: 'Login Access Only',
      container: 'custpage_filters'
    });
    loginAccessOnly.defaultValue = filters.loginAccessOnly ? 'T' : 'F';

    const showNeverLogged = form.addField({
      id: 'custpage_show_never_logged',
      type: serverWidget.FieldType.CHECKBOX,
      label: 'Show Never Logged In',
      container: 'custpage_filters'
    });
    showNeverLogged.defaultValue = filters.showNeverLogged ? 'T' : 'F';

    const includeInactive = form.addField({
      id: 'custpage_include_inactive',
      type: serverWidget.FieldType.CHECKBOX,
      label: 'Include Inactive Employees',
      container: 'custpage_filters'
    });
    includeInactive.defaultValue = filters.includeInactive ? 'T' : 'F';

    form.addSubmitButton({ label: 'Refresh Login Report' });
  }

  function normalizeFilters(params) {
    return {
      employeeText: String(params.custpage_employee_text || params.employeeText || '').trim(),
      roleText: String(params.custpage_role_text || params.roleText || '').trim(),
      staleDays: normalizePositiveInteger(params.custpage_stale_days || params.staleDays, CONFIG.staleDaysDefault),
      chartMonths: normalizePositiveInteger(params.custpage_chart_months || params.chartMonths, CONFIG.monthlyChartMonthsDefault),
      loginAccessOnly: normalizeCheckbox(params.custpage_login_access_only || params.loginAccessOnly, true),
      showNeverLogged: normalizeCheckbox(params.custpage_show_never_logged || params.showNeverLogged, true),
      includeInactive: normalizeCheckbox(params.custpage_include_inactive || params.includeInactive, false)
    };
  }

  function normalizeCheckbox(value, defaultValue) {
    if (value === null || value === undefined || value === '') return !!defaultValue;

    const text = String(value).toUpperCase();
    return text === 'T' || text === 'TRUE' || text === 'Y' || text === 'YES' || text === '1';
  }

  function normalizePositiveInteger(value, defaultValue) {
    const n = Number(value || defaultValue);
    return n > 0 ? Math.floor(n) : defaultValue;
  }

  function buildChartFilters(filters) {
    return Object.assign({}, filters, {
      roleText: '',
      showNeverLogged: false
    });
  }

  function isChartRole(roleName) {
    const prefix = String(CONFIG.chartRolePrefix || '').toLowerCase();
    const normalizedRoleName = String(roleName || '').trim().toLowerCase();
    const extraRoles = (CONFIG.chartExtraRoles || []).map(role => String(role || '').trim().toLowerCase());

    if (extraRoles.indexOf(normalizedRoleName) >= 0) return true;
    if (!prefix) return true;

    return normalizedRoleName.indexOf(prefix) === 0;
  }

  function getEmployeeLoginData(filters) {
    try {
      return runEmployeeLastLoginSearch(filters, filters.loginAccessOnly);
    } catch (e) {
      if (!filters.loginAccessOnly) throw e;

      try {
        const fallbackData = runEmployeeLastLoginSearch(filters, false);
        fallbackData.warnings.push(
          'Login Access filter could not be applied in this account/search context, so active employees are shown without that filter.'
        );
        return fallbackData;
      } catch (fallbackError) {
        throw Error(
          'Unable to read Employee Login Audit Trail data. Confirm the deployment role has permission to view Employee records and Login Audit Trail. Original error: ' +
          (e && e.message ? e.message : String(e)) +
          ' Fallback error: ' +
          (fallbackError && fallbackError.message ? fallbackError.message : String(fallbackError))
        );
      }
    }
  }

  function runEmployeeLastLoginSearch(filters, useLoginAccessFilter) {
    const columns = buildEmployeeLoginColumns();
    const employeeSearch = search.create({
      type: search.Type.EMPLOYEE,
      filters: buildEmployeeSearchFilters(filters, useLoginAccessFilter),
      columns: columns.list
    });
    const employeeMap = {};
    const stats = {
      scannedSummaryRows: 0,
      sourceSummaryRows: 0,
      queryLimit: CONFIG.summaryRowLimit,
      hitQueryLimit: false,
      usedLoginAccessFilter: !!useLoginAccessFilter
    };

    const pagedData = employeeSearch.runPaged({ pageSize: getPageSize() });
    stats.sourceSummaryRows = pagedData.count || 0;

    for (let i = 0; i < pagedData.pageRanges.length; i++) {
      if (stats.scannedSummaryRows >= CONFIG.summaryRowLimit) break;

      const page = pagedData.fetch({ index: pagedData.pageRanges[i].index });

      for (let j = 0; j < page.data.length; j++) {
        if (stats.scannedSummaryRows >= CONFIG.summaryRowLimit) break;

        stats.scannedSummaryRows += 1;
        processEmployeeLoginResult(page.data[j], columns, employeeMap);
      }
    }

    stats.hitQueryLimit = stats.sourceSummaryRows > stats.scannedSummaryRows;

    const baseRows = Object.keys(employeeMap).map(id => employeeMap[id]);
    const chartRows = finalizeEmployeeRows(baseRows, Object.assign({}, filters, {
      roleText: '',
      showNeverLogged: false
    }));
    const rows = finalizeEmployeeRows(baseRows, filters);
    const warnings = [];
    const fallbackTodayRoleTrend = buildTodayRoleTrendFromRows(chartRows);
    const fallbackMonthlyRoleTrend = buildMonthlyRoleTrendFromRows(chartRows, filters);
    let todayRoleTrend = fallbackTodayRoleTrend;
    let monthlyRoleTrend = fallbackMonthlyRoleTrend;

    try {
      const searchedTodayRoleTrend = buildTodayRoleLoginTrend(buildChartFilters(filters), useLoginAccessFilter);
      todayRoleTrend = searchedTodayRoleTrend.roles.length || !fallbackTodayRoleTrend.roles.length ?
        searchedTodayRoleTrend :
        fallbackTodayRoleTrend;
    } catch (e) {
      log.error({ title: 'Employee today role login chart failed', details: e });
      todayRoleTrend = fallbackTodayRoleTrend;
    }

    try {
      const searchedMonthlyRoleTrend = buildMonthlyRoleLoginTrend(buildChartFilters(filters), useLoginAccessFilter);
      monthlyRoleTrend = searchedMonthlyRoleTrend.roles.length || !fallbackMonthlyRoleTrend.roles.length ?
        searchedMonthlyRoleTrend :
        fallbackMonthlyRoleTrend;
    } catch (e) {
      log.error({ title: 'Employee monthly role login trend failed', details: e });
      monthlyRoleTrend = fallbackMonthlyRoleTrend;
    }

    if (stats.hitQueryLimit) {
      warnings.push(
        'The search returned more summary rows than the configured limit. Narrow filters or increase CONFIG.summaryRowLimit for complete results.'
      );
    }

    if (monthlyRoleTrend.stats && monthlyRoleTrend.stats.hitQueryLimit) {
      warnings.push(
        'Monthly role chart reached its configured summary row limit. Reduce chart months or increase CONFIG.monthlySummaryRowLimit for complete monthly counts.'
      );
    }

    if (todayRoleTrend.stats && todayRoleTrend.stats.hitQueryLimit) {
      warnings.push(
        'Today role chart reached its configured summary row limit. Increase CONFIG.todaySummaryRowLimit for complete today counts.'
      );
    }

    return {
      generatedAt: new Date().toISOString(),
      filters,
      rows,
      summary: buildSummary(rows, filters),
      todayRoleTrend,
      monthlyRoleTrend,
      stats,
      warnings
    };
  }

  function buildTodayRoleLoginTrend(filters, useLoginAccessFilter) {
    const today = stripTime(new Date());
    const columns = buildTodayRoleLoginColumns();
    const employeeSearch = search.create({
      type: search.Type.EMPLOYEE,
      filters: buildTodayRoleSearchFilters(filters, useLoginAccessFilter, today),
      columns: columns.list
    });
    const roleMap = {};
    const uniqueRoleEmployee = {};
    const stats = {
      scannedSummaryRows: 0,
      sourceSummaryRows: 0,
      queryLimit: CONFIG.todaySummaryRowLimit,
      hitQueryLimit: false
    };
    const pagedData = employeeSearch.runPaged({ pageSize: getPageSize() });
    stats.sourceSummaryRows = pagedData.count || 0;

    for (let i = 0; i < pagedData.pageRanges.length; i++) {
      if (stats.scannedSummaryRows >= CONFIG.todaySummaryRowLimit) break;

      const page = pagedData.fetch({ index: pagedData.pageRanges[i].index });

      for (let j = 0; j < page.data.length; j++) {
        if (stats.scannedSummaryRows >= CONFIG.todaySummaryRowLimit) break;

        stats.scannedSummaryRows += 1;
        processTodayRoleLoginResult({
          result: page.data[j],
          columns,
          filters,
          roleMap,
          uniqueRoleEmployee
        });
      }
    }

    stats.hitQueryLimit = stats.sourceSummaryRows > stats.scannedSummaryRows;
    return finalizeTodayRoleTrend(roleMap, today, stats);
  }

  function buildEmptyTodayRoleTrend() {
    return finalizeTodayRoleTrend({}, stripTime(new Date()), {
      scannedSummaryRows: 0,
      sourceSummaryRows: 0,
      queryLimit: CONFIG.todaySummaryRowLimit,
      hitQueryLimit: false
    });
  }

  function buildTodayRoleTrendFromRows(rows) {
    const today = stripTime(new Date());
    const todayKey = toIsoDate(today);
    const roleMap = {};

    (rows || []).forEach(row => {
      if (!row.lastLoginDate || toIsoDate(stripTime(row.lastLoginDate)) !== todayKey) return;

      const roleName = row.roleName || 'No Role';
      if (!isChartRole(roleName)) return;

      if (!roleMap[roleName]) {
        roleMap[roleName] = {
          roleName,
          count: 0,
          employees: []
        };
      }

      roleMap[roleName].count += 1;
      roleMap[roleName].employees.push({
        id: row.id,
        name: row.name,
        email: row.email,
        department: getDepartmentName(row),
        lastLogin: row.lastLogin || '',
        weekendLogin: isWeekendDate(row.lastLoginDate),
        weekendLoginLabel: getWeekendLoginLabel(row.lastLoginDate),
        employeeUrl: row.employeeUrl
      });
    });

    return finalizeTodayRoleTrend(roleMap, today, {
      scannedSummaryRows: rows.length,
      sourceSummaryRows: rows.length,
      queryLimit: CONFIG.summaryRowLimit,
      hitQueryLimit: false,
      source: 'latestLoginRows'
    });
  }

  function buildTodayRoleLoginColumns() {
    const summary = search.Summary;
    const colInternalId = search.createColumn({ name: 'internalid', summary: summary.GROUP });
    const colEntityId = search.createColumn({ name: 'entityid', summary: summary.GROUP });
    const colEmail = search.createColumn({ name: 'email', summary: summary.GROUP });
    const colDepartment = search.createColumn({ name: 'department', summary: summary.GROUP });
    const colLastLogin = search.createColumn({
      name: 'date',
      join: CONFIG.loginAuditJoin,
      summary: summary.MAX
    });
    const colLoginRole = search.createColumn({
      name: 'role',
      join: CONFIG.loginAuditJoin,
      summary: summary.GROUP
    });
    const colLoginStatus = search.createColumn({
      name: 'status',
      join: CONFIG.loginAuditJoin,
      summary: summary.GROUP
    });

    return {
      list: [
        colInternalId,
        colEntityId,
        colEmail,
        colDepartment,
        colLastLogin,
        colLoginRole,
        colLoginStatus
      ],
      colInternalId,
      colEntityId,
      colEmail,
      colDepartment,
      colLastLogin,
      colLoginRole,
      colLoginStatus
    };
  }

  function buildTodayRoleSearchFilters(filters, useLoginAccessFilter, today) {
    const searchFilters = buildEmployeeSearchFilters(filters, useLoginAccessFilter) || [];

    pushAndFilter(searchFilters, [CONFIG.loginAuditJoin + '.date', 'onorafter', formatSearchDate(today)]);
    pushAndFilter(searchFilters, [CONFIG.loginAuditJoin + '.date', 'onorbefore', formatSearchDate(today)]);

    return searchFilters;
  }

  function processTodayRoleLoginResult(options) {
    const result = options.result;
    const columns = options.columns;
    const filters = options.filters;
    const employeeId = String(result.getValue(columns.colInternalId) || '');
    const employeeName = String(result.getValue(columns.colEntityId) || '');
    const employeeEmail = String(result.getValue(columns.colEmail) || '');
    const departmentName = String(result.getText(columns.colDepartment) || result.getValue(columns.colDepartment) || 'No Department');
    const lastLoginValue = result.getValue(columns.colLastLogin);
    const lastLogin = String(lastLoginValue || '');
    const status = String(result.getText(columns.colLoginStatus) || result.getValue(columns.colLoginStatus) || '');

    if (!employeeId || !isSuccessfulLoginStatus(status)) {
      return;
    }

    const roleName = String(result.getText(columns.colLoginRole) || result.getValue(columns.colLoginRole) || 'No Role');

    if (!isChartRole(roleName)) {
      return;
    }

    if (filters.roleText && roleName.toLowerCase().indexOf(String(filters.roleText).toLowerCase()) < 0) {
      return;
    }

    const uniqueKey = roleName + '|' + employeeId;
    if (options.uniqueRoleEmployee[uniqueKey]) return;

    options.uniqueRoleEmployee[uniqueKey] = true;

    if (!options.roleMap[roleName]) {
      options.roleMap[roleName] = {
        roleName,
        count: 0,
        employees: []
      };
    }

    options.roleMap[roleName].count += 1;
    options.roleMap[roleName].employees.push({
      id: employeeId,
      name: employeeName,
      email: employeeEmail,
      department: departmentName,
      lastLogin,
      weekendLogin: isWeekendLoginValue(lastLoginValue),
      weekendLoginLabel: getWeekendLoginLabel(lastLoginValue),
      employeeUrl: buildEmployeeUrl(employeeId)
    });
  }

  function finalizeTodayRoleTrend(roleMap, today, stats) {
    const roleLimit = Math.max(1, Number(CONFIG.todayRoleLimit || 12));
    const sortedRoles = Object.keys(roleMap)
      .map(roleName => roleMap[roleName])
      .sort((a, b) => b.count - a.count || a.roleName.localeCompare(b.roleName));
    const visibleRoles = sortedRoles.slice(0, roleLimit);
    const hiddenRoles = sortedRoles.slice(roleLimit);

    if (hiddenRoles.length) {
      visibleRoles.push({
        roleName: 'Other PSiQ/Admin Roles',
        count: hiddenRoles.reduce((sum, role) => sum + Number(role.count || 0), 0),
        employees: hiddenRoles.reduce((list, role) => list.concat(role.employees || []), [])
      });
    }

    const roles = visibleRoles.map((role, index) => {
      return {
        roleName: role.roleName,
        count: Number(role.count || 0),
        color: getRoleColor(index),
        lightColor: getRoleLightColor(index),
        employees: (role.employees || []).slice().sort(compareTodayRoleEmployees)
      };
    });

    return {
      dateKey: toIsoDate(today),
      dateLabel: formatFullDate(today),
      roles,
      total: roles.reduce((sum, role) => sum + Number(role.count || 0), 0),
      maxRoleCount: Math.max.apply(null, roles.map(role => role.count).concat([1])),
      hiddenRoleCount: hiddenRoles.length,
      stats
    };
  }

  function compareTodayRoleEmployees(a, b) {
    return String(a.name || '').localeCompare(String(b.name || '')) ||
      String(a.email || '').localeCompare(String(b.email || ''));
  }

  function buildMonthlyRoleLoginTrend(filters, useLoginAccessFilter) {
    const monthBuckets = buildMonthBuckets(filters.chartMonths);
    const monthLookup = buildMonthLookup(monthBuckets);
    const columns = buildMonthlyRoleLoginColumns();
    const employeeSearch = search.create({
      type: search.Type.EMPLOYEE,
      filters: buildMonthlyRoleSearchFilters(filters, useLoginAccessFilter, monthBuckets[0].startDate),
      columns: columns.list
    });
    const roleMap = {};
    const uniqueRoleMonthEmployee = {};
    const stats = {
      scannedSummaryRows: 0,
      sourceSummaryRows: 0,
      queryLimit: CONFIG.monthlySummaryRowLimit,
      hitQueryLimit: false
    };
    const pagedData = employeeSearch.runPaged({ pageSize: getPageSize() });
    stats.sourceSummaryRows = pagedData.count || 0;

    for (let i = 0; i < pagedData.pageRanges.length; i++) {
      if (stats.scannedSummaryRows >= CONFIG.monthlySummaryRowLimit) break;

      const page = pagedData.fetch({ index: pagedData.pageRanges[i].index });

      for (let j = 0; j < page.data.length; j++) {
        if (stats.scannedSummaryRows >= CONFIG.monthlySummaryRowLimit) break;

        stats.scannedSummaryRows += 1;
        processMonthlyRoleLoginResult({
          result: page.data[j],
          columns,
          filters,
          monthLookup,
          roleMap,
          uniqueRoleMonthEmployee
        });
      }
    }

    stats.hitQueryLimit = stats.sourceSummaryRows > stats.scannedSummaryRows;
    return finalizeMonthlyRoleTrend(monthBuckets, roleMap, stats);
  }

  function buildEmptyMonthlyRoleTrend(filters) {
    return finalizeMonthlyRoleTrend(buildMonthBuckets(filters.chartMonths), {}, {
      scannedSummaryRows: 0,
      sourceSummaryRows: 0,
      queryLimit: CONFIG.monthlySummaryRowLimit,
      hitQueryLimit: false
    });
  }

  function buildMonthlyRoleTrendFromRows(rows, filters) {
    const monthBuckets = buildMonthBuckets(filters.chartMonths);
    const monthLookup = buildMonthLookup(monthBuckets);
    const roleMap = {};

    (rows || []).forEach(row => {
      if (!row.lastLoginDate) return;

      const monthKey = toMonthKey(stripTime(row.lastLoginDate));
      if (!monthLookup[monthKey]) return;

      const roleName = row.roleName || 'No Role';
      if (!isChartRole(roleName)) return;

      if (!roleMap[roleName]) {
        roleMap[roleName] = {
          roleName,
          total: 0,
          countByMonth: {},
          employeesByMonth: {}
        };
      }

      roleMap[roleName].countByMonth[monthKey] = Number(roleMap[roleName].countByMonth[monthKey] || 0) + 1;
      roleMap[roleName].total += 1;
      addMonthlyRoleEmployee(roleMap[roleName], monthKey, {
        id: row.id,
        name: row.name,
        email: row.email,
        department: getDepartmentName(row),
        lastLogin: row.lastLogin || '',
        weekendLogin: isWeekendDate(row.lastLoginDate),
        weekendLoginLabel: getWeekendLoginLabel(row.lastLoginDate),
        employeeUrl: row.employeeUrl
      });
    });

    return finalizeMonthlyRoleTrend(monthBuckets, roleMap, {
      scannedSummaryRows: rows.length,
      sourceSummaryRows: rows.length,
      queryLimit: CONFIG.summaryRowLimit,
      hitQueryLimit: false,
      source: 'latestLoginRows'
    });
  }

  function buildMonthlyRoleLoginColumns() {
    const summary = search.Summary;
    const colInternalId = search.createColumn({ name: 'internalid', summary: summary.GROUP });
    const colEntityId = search.createColumn({ name: 'entityid', summary: summary.GROUP });
    const colEmail = search.createColumn({ name: 'email', summary: summary.GROUP });
    const colDepartment = search.createColumn({ name: 'department', summary: summary.GROUP });
    const colLoginMonth = search.createColumn({
      name: 'formulatext',
      summary: summary.GROUP,
      formula: "TO_CHAR({loginaudittrail.date}, 'YYYY-MM')"
    });
    const colLastLogin = search.createColumn({
      name: 'date',
      join: CONFIG.loginAuditJoin,
      summary: summary.MAX
    });
    const colLoginRole = search.createColumn({
      name: 'role',
      join: CONFIG.loginAuditJoin,
      summary: summary.GROUP
    });
    const colLoginStatus = search.createColumn({
      name: 'status',
      join: CONFIG.loginAuditJoin,
      summary: summary.GROUP
    });

    return {
      list: [
        colInternalId,
        colEntityId,
        colEmail,
        colDepartment,
        colLoginMonth,
        colLastLogin,
        colLoginRole,
        colLoginStatus
      ],
      colInternalId,
      colEntityId,
      colEmail,
      colDepartment,
      colLoginMonth,
      colLastLogin,
      colLoginRole,
      colLoginStatus
    };
  }

  function buildMonthlyRoleSearchFilters(filters, useLoginAccessFilter, startDate) {
    const searchFilters = buildEmployeeSearchFilters(filters, useLoginAccessFilter) || [];

    pushAndFilter(searchFilters, [CONFIG.loginAuditJoin + '.date', 'onorafter', formatSearchDate(startDate)]);

    return searchFilters;
  }

  function processMonthlyRoleLoginResult(options) {
    const result = options.result;
    const columns = options.columns;
    const filters = options.filters;
    const employeeId = String(result.getValue(columns.colInternalId) || '');
    const employeeName = String(result.getValue(columns.colEntityId) || '');
    const employeeEmail = String(result.getValue(columns.colEmail) || '');
    const departmentName = String(result.getText(columns.colDepartment) || result.getValue(columns.colDepartment) || 'No Department');
    const monthKey = String(result.getValue(columns.colLoginMonth) || '').substring(0, 7);
    const lastLoginValue = result.getValue(columns.colLastLogin);
    const lastLogin = String(lastLoginValue || '');
    const status = String(result.getText(columns.colLoginStatus) || result.getValue(columns.colLoginStatus) || '');

    if (!employeeId || !options.monthLookup[monthKey] || !isSuccessfulLoginStatus(status)) {
      return;
    }

    const roleName = String(result.getText(columns.colLoginRole) || result.getValue(columns.colLoginRole) || 'No Role');

    if (!isChartRole(roleName)) {
      return;
    }

    if (filters.roleText && roleName.toLowerCase().indexOf(String(filters.roleText).toLowerCase()) < 0) {
      return;
    }

    const uniqueKey = roleName + '|' + monthKey + '|' + employeeId;
    if (options.uniqueRoleMonthEmployee[uniqueKey]) return;

    options.uniqueRoleMonthEmployee[uniqueKey] = true;

    if (!options.roleMap[roleName]) {
      options.roleMap[roleName] = {
        roleName,
        total: 0,
        countByMonth: {},
        employeesByMonth: {}
      };
    }

    options.roleMap[roleName].countByMonth[monthKey] = Number(options.roleMap[roleName].countByMonth[monthKey] || 0) + 1;
    options.roleMap[roleName].total += 1;
    addMonthlyRoleEmployee(options.roleMap[roleName], monthKey, {
      id: employeeId,
      name: employeeName,
      email: employeeEmail,
      department: departmentName,
      lastLogin,
      weekendLogin: isWeekendLoginValue(lastLoginValue),
      weekendLoginLabel: getWeekendLoginLabel(lastLoginValue),
      employeeUrl: buildEmployeeUrl(employeeId)
    });
  }

  function addMonthlyRoleEmployee(role, monthKey, employee) {
    if (!role.employeesByMonth) role.employeesByMonth = {};
    if (!role.employeesByMonth[monthKey]) role.employeesByMonth[monthKey] = [];

    role.employeesByMonth[monthKey].push(employee);
  }

  function finalizeMonthlyRoleTrend(monthBuckets, roleMap, stats) {
    const sortedRoles = Object.keys(roleMap)
      .map(roleName => roleMap[roleName])
      .sort((a, b) => b.total - a.total || a.roleName.localeCompare(b.roleName));
    const chartRoleLimit = Math.max(1, Number(CONFIG.monthlyChartRoleLimit || 5));
    const detailRoleLimit = Math.max(chartRoleLimit, Number(CONFIG.monthlyRoleLimit || 60));
    const chartRoles = buildMonthlyRoleSeries(sortedRoles, monthBuckets, chartRoleLimit);
    const detailRoles = buildMonthlyRoleSeries(sortedRoles, monthBuckets, detailRoleLimit);
    const roles = chartRoles.roles;

    const months = monthBuckets.map(month => {
      const total = roles.reduce((sum, role) => sum + Number(role.countByMonth[month.key] || 0), 0);
      return Object.assign({}, month, { total });
    });

    return {
      months,
      roles,
      detailRoles: detailRoles.roles,
      maxMonthTotal: Math.max.apply(null, months.map(month => month.total).concat([1])),
      hiddenRoleCount: chartRoles.hiddenRoleCount,
      hiddenDetailRoleCount: detailRoles.hiddenRoleCount,
      stats
    };
  }

  function buildMonthlyRoleSeries(sortedRoles, monthBuckets, roleLimit) {
    const visibleRoles = sortedRoles.slice(0, roleLimit);
    const hiddenRoles = sortedRoles.slice(roleLimit);

    if (hiddenRoles.length) {
      const otherRole = {
        roleName: 'Other PSiQ/Admin Roles',
        total: 0,
        countByMonth: {},
        employeesByMonth: {}
      };

      hiddenRoles.forEach(role => {
        otherRole.total += Number(role.total || 0);
        monthBuckets.forEach(month => {
          otherRole.countByMonth[month.key] = Number(otherRole.countByMonth[month.key] || 0) +
            Number(role.countByMonth[month.key] || 0);
          otherRole.employeesByMonth[month.key] = (otherRole.employeesByMonth[month.key] || [])
            .concat((role.employeesByMonth && role.employeesByMonth[month.key]) || []);
        });
      });

      visibleRoles.push(otherRole);
    }

    return {
      hiddenRoleCount: hiddenRoles.length,
      roles: visibleRoles.map((role, index) => {
        return {
          roleName: role.roleName,
          total: role.total,
          color: getRoleColor(index),
          lightColor: getRoleLightColor(index),
          countByMonth: monthBuckets.reduce((map, month) => {
            map[month.key] = Number(role.countByMonth[month.key] || 0);
            return map;
          }, {}),
          employeesByMonth: monthBuckets.reduce((map, month) => {
            map[month.key] = ((role.employeesByMonth && role.employeesByMonth[month.key]) || [])
              .slice()
              .sort(compareTodayRoleEmployees);
            return map;
          }, {})
        };
      })
    };
  }

  function buildMonthBuckets(monthCount) {
    const count = Math.max(1, Math.min(24, Number(monthCount || CONFIG.monthlyChartMonthsDefault)));
    const currentMonth = new Date();
    const buckets = [];

    currentMonth.setDate(1);
    currentMonth.setHours(0, 0, 0, 0);

    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - i, 1);
      buckets.push({
        key: toMonthKey(d),
        label: formatMonthLabel(d),
        title: formatMonthTitle(d),
        startDate: d
      });
    }

    return buckets;
  }

  function buildMonthLookup(monthBuckets) {
    return monthBuckets.reduce((map, month) => {
      map[month.key] = true;
      return map;
    }, {});
  }

  function toMonthKey(dateObj) {
    return [
      dateObj.getFullYear(),
      String(dateObj.getMonth() + 1).padStart(2, '0')
    ].join('-');
  }

  function formatMonthLabel(dateObj) {
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return names[dateObj.getMonth()] + " '" + String(dateObj.getFullYear()).substring(2);
  }

  function formatMonthTitle(dateObj) {
    const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return names[dateObj.getMonth()] + ' ' + dateObj.getFullYear();
  }

  function formatFullDate(dateObj) {
    const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return names[dateObj.getMonth()] + ' ' + dateObj.getDate() + ', ' + dateObj.getFullYear();
  }

  function toIsoDate(dateObj) {
    return [
      dateObj.getFullYear(),
      String(dateObj.getMonth() + 1).padStart(2, '0'),
      String(dateObj.getDate()).padStart(2, '0')
    ].join('-');
  }

  function getRoleColor(index) {
    const colors = [
      '#2563eb', '#14b8a6', '#f97316', '#d946ef', '#8b5cf6', '#64748b',
      '#0ea5e9', '#84cc16', '#ef4444', '#f59e0b', '#0f766e', '#a855f7',
      '#22c55e', '#eab308', '#0891b2', '#f43f5e', '#3b82f6', '#ea580c',
      '#65a30d', '#7c3aed', '#be123c', '#4f46e5', '#06b6d4', '#db2777'
    ];
    return colors[index % colors.length];
  }

  function getRoleLightColor(index) {
    const colors = [
      '#93c5fd', '#5eead4', '#fdba74', '#c4b5fd', '#f9a8d4', '#bef264',
      '#7dd3fc', '#fcd34d', '#cbd5e1', '#fca5a5', '#67e8f9', '#d8b4fe',
      '#86efac', '#fde047', '#5eead4', '#fda4af', '#bfdbfe', '#f0abfc',
      '#d9f99d', '#fed7aa', '#a5f3fc', '#ddd6fe', '#fecdd3', '#c7d2fe'
    ];
    return colors[index % colors.length];
  }

  function buildEmployeeLoginColumns() {
    const summary = search.Summary;
    const colInternalId = search.createColumn({ name: 'internalid', summary: summary.GROUP, sort: search.Sort.ASC });
    const colEntityId = search.createColumn({ name: 'entityid', summary: summary.GROUP });
    const colEmail = search.createColumn({ name: 'email', summary: summary.GROUP });
    const colDepartment = search.createColumn({ name: 'department', summary: summary.GROUP });
    const colInactive = search.createColumn({ name: 'isinactive', summary: summary.GROUP });
    const colLastLogin = search.createColumn({
      name: 'date',
      join: CONFIG.loginAuditJoin,
      summary: summary.MAX,
      sort: search.Sort.DESC
    });
    const colLoginRole = search.createColumn({
      name: 'role',
      join: CONFIG.loginAuditJoin,
      summary: summary.GROUP
    });
    const colLoginStatus = search.createColumn({
      name: 'status',
      join: CONFIG.loginAuditJoin,
      summary: summary.GROUP
    });

    return {
      list: [
        colInternalId,
        colEntityId,
        colEmail,
        colDepartment,
        colInactive,
        colLastLogin,
        colLoginRole,
        colLoginStatus
      ],
      colInternalId,
      colEntityId,
      colEmail,
      colDepartment,
      colInactive,
      colLastLogin,
      colLoginRole,
      colLoginStatus
    };
  }

  function buildEmployeeSearchFilters(filters, useLoginAccessFilter) {
    const searchFilters = [];

    if (!filters.includeInactive) {
      pushAndFilter(searchFilters, ['isinactive', 'is', 'F']);
    }

    if (useLoginAccessFilter) {
      pushAndFilter(searchFilters, ['giveaccess', 'is', 'T']);
    }

    if (filters.employeeText) {
      const text = filters.employeeText;
      pushAndFilter(searchFilters, [
        ['entityid', 'contains', text],
        'OR',
        ['email', 'contains', text],
        'OR',
        ['firstname', 'contains', text],
        'OR',
        ['lastname', 'contains', text]
      ]);
    }

    return searchFilters.length ? searchFilters : null;
  }

  function pushAndFilter(filters, clause) {
    if (filters.length) filters.push('AND');
    filters.push(clause);
  }

  function processEmployeeLoginResult(result, columns, employeeMap) {
    const id = String(result.getValue(columns.colInternalId) || '');
    if (!id) return;

    if (!employeeMap[id]) {
      employeeMap[id] = {
        id,
        name: String(result.getValue(columns.colEntityId) || ''),
        email: String(result.getValue(columns.colEmail) || ''),
        departmentId: String(result.getValue(columns.colDepartment) || ''),
        departmentName: String(result.getText(columns.colDepartment) || result.getValue(columns.colDepartment) || ''),
        inactive: isTrueValue(result.getValue(columns.colInactive)),
        employeeUrl: buildEmployeeUrl(id),
        lastLogin: '',
        lastLoginDate: null,
        roleId: '',
        roleName: '',
        loginStatus: ''
      };
    }

    const status = String(result.getText(columns.colLoginStatus) || result.getValue(columns.colLoginStatus) || '');
    if (!isSuccessfulLoginStatus(status)) return;

    const loginValue = result.getValue(columns.colLastLogin);
    const loginDate = parseNsDateTime(loginValue);
    if (!loginDate) return;

    const row = employeeMap[id];
    if (!row.lastLoginDate || loginDate.getTime() > row.lastLoginDate.getTime()) {
      row.lastLogin = String(loginValue || '');
      row.lastLoginDate = loginDate;
      row.roleId = String(result.getValue(columns.colLoginRole) || '');
      row.roleName = String(result.getText(columns.colLoginRole) || result.getValue(columns.colLoginRole) || 'No Role');
      row.loginStatus = status;
    }
  }

  function finalizeEmployeeRows(rows, filters) {
    const roleFilter = String(filters.roleText || '').toLowerCase();
    const today = stripTime(new Date());

    return (rows || []).map(row => {
      const daysSinceLogin = row.lastLoginDate ?
        Math.max(0, Math.floor((today.getTime() - stripTime(row.lastLoginDate).getTime()) / (24 * 60 * 60 * 1000))) :
        null;

      return Object.assign({}, row, {
        daysSinceLogin,
        loginAgeLabel: daysSinceLogin === null ? 'Never' : String(daysSinceLogin),
        stale: daysSinceLogin === null || daysSinceLogin >= filters.staleDays
      });
    }).filter(row => {
      if (!filters.showNeverLogged && !row.lastLoginDate) return false;
      if (roleFilter && String(row.roleName || '').toLowerCase().indexOf(roleFilter) < 0) return false;
      return true;
    }).sort(compareEmployeeRows);
  }

  function compareEmployeeRows(a, b) {
    const aTime = a.lastLoginDate ? a.lastLoginDate.getTime() : 0;
    const bTime = b.lastLoginDate ? b.lastLoginDate.getTime() : 0;

    return bTime - aTime || a.name.localeCompare(b.name);
  }

  function buildSummary(rows, filters) {
    const loggedIn = rows.filter(r => r.lastLoginDate).length;
    const neverLogged = rows.filter(r => !r.lastLoginDate).length;
    const stale = rows.filter(r => r.stale).length;
    const inactive = rows.filter(r => r.inactive).length;
    const roleMap = {};
    const departmentMap = {};

    rows.forEach(r => {
      if (r.roleName) roleMap[r.roleName] = true;
      departmentMap[getDepartmentName(r)] = true;
    });

    return {
      total: rows.length,
      loggedIn,
      neverLogged,
      stale,
      inactive,
      staleDays: filters.staleDays,
      uniqueRoles: Object.keys(roleMap).length,
      uniqueDepartments: Object.keys(departmentMap).length
    };
  }

  function buildHtml(data, filters) {
    return `
${buildCss()}
<div class="dash">
  <div class="dash-topbar">
    <div>
      <h1>${esc(CONFIG.dashboardTitle)}</h1>
      <div class="dash-sub">Latest successful employee login by Login Audit Trail role &middot; Generated ${esc(formatLastRefreshedText(data.generatedAt))}</div>
    </div>
    <div class="dash-actions">
      <label class="auto-refresh-toggle" title="Automatically refresh this report">
        <input type="checkbox" id="autoRefreshEnabled" onchange="updateAutoRefreshSettings()">
        <span>Auto Refresh</span>
      </label>
      <select class="auto-refresh-frequency" id="autoRefreshFrequency" onchange="updateAutoRefreshSettings()" title="Auto refresh frequency">
        <option value="60">Every 1 min</option>
        <option value="300">Every 5 min</option>
        <option value="900">Every 15 min</option>
        <option value="1800">Every 30 min</option>
      </select>
      <span class="auto-refresh-status" id="autoRefreshStatus"></span>
      <button type="button" class="btn btn-primary" onclick="refreshLoginReport()">Refresh Report</button>
      <button type="button" class="btn" onclick="exportEmployeeLoginCsv()">Export CSV</button>
    </div>
  </div>

  ${buildWarningsHtml(data.warnings || [])}
  ${buildKpiHtml(data.summary, data.rows || [])}
  ${buildDepartmentDistributionTileHtml(data.rows || [])}
  ${buildTodayRoleTrendHtml(data.todayRoleTrend, filters)}
  ${buildMonthlyRoleTrendHtml(data.monthlyRoleTrend, filters)}

  <section class="panel">
    <div class="panel-head">
      <div>
        <h2>Employee Login Detail</h2>
        <span>${esc(buildResultSubtitle(data, filters))}</span>
      </div>
    </div>
    ${buildTableHtml(data.rows || [])}
  </section>

  <div class="dash-footer">
    ${buildDeveloperCreditHtml()}
    <span class="version-badge">v${esc(CONFIG.version)}</span>
  </div>
</div>
${buildEmployeeLoginPopupHtml()}
${buildScript()}
`;
  }

  function buildErrorHtml(error) {
    return `
${buildCss()}
<div class="dash">
  <div class="error-banner">
    Unable to load employee last-login data: ${esc(error && error.message ? error.message : String(error))}
  </div>
  <div class="source-help">
    Confirm the deployment role can view Employee records and the Login Audit Trail, then rerun the Suitelet.
  </div>
</div>`;
  }

  function buildWarningsHtml(warnings) {
    if (!warnings || !warnings.length) return '';

    return warnings.map(warning => {
      return `<div class="warning-banner">${esc(warning)}</div>`;
    }).join('');
  }

  function buildDeveloperCreditHtml() {
    return `<span class="developer-credit">Developed by <strong>${esc(CONFIG.developedBy)}</strong>${buildDeveloperAdminBadgeHtml(false)}</span>`;
  }

  function buildDeveloperAdminBadgeHtml(compact) {
    const className = compact ? 'developer-admin-badge compact' : 'developer-admin-badge';
    const label = compact ? 'Dev' : 'Dashboard Developer';
    const title = CONFIG.developedBy + ' | ' + CONFIG.developerTitle;

    return `<span class="${className}" title="${escAttr(title)}">
      <span class="developer-admin-icon" aria-hidden="true">🧑🏻‍💻</span>
      <span class="developer-admin-label">${esc(label)}</span>
      ${compact ? '' : `<small>${esc(CONFIG.developerTitle)}</small>`}
    </span>`;
  }

  function isDashboardDeveloperEmployee(employee) {
    const name = normalizeDeveloperMatchText(employee && employee.name);
    const email = normalizeDeveloperMatchText(employee && employee.email);
    const names = (CONFIG.developerEmployeeNames || []).map(normalizeDeveloperMatchText);
    const emails = (CONFIG.developerEmployeeEmails || []).map(normalizeDeveloperMatchText);

    return (name && names.indexOf(name) >= 0) || (email && emails.indexOf(email) >= 0);
  }

  function normalizeDeveloperMatchText(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function buildKpiHtml(summary, rows) {
    const cards = [
      { id: 'shown', label: 'Employees Shown', value: summary.total, className: '' },
      { id: 'logged', label: 'Logged In', value: summary.loggedIn, className: 'good' },
      { id: 'never', label: 'Never Logged In', value: summary.neverLogged, className: 'neutral' },
      { id: 'stale', label: 'Stale / No Login', value: summary.stale, className: 'bad', detail: summary.staleDays + '+ days' },
      { id: 'roles', label: 'Roles Seen', value: summary.uniqueRoles, className: 'wide' },
      { id: 'departments', label: 'Departments', value: summary.uniqueDepartments, className: 'dept' }
    ];

    return `<div class="kpi-grid">${cards.map(card => `
      <button type="button" class="kpi-card ${escAttr(card.className)}" data-kpi-id="${escAttr(card.id)}" onclick="showKpiDetail('${escAttr(card.id)}')">
        <div class="kpi-label">${esc(card.label)}</div>
        <div class="kpi-value">${esc(card.value)}</div>
        ${card.detail ? `<div class="kpi-detail">${esc(card.detail)}</div>` : ''}
      </button>`).join('')}</div>${buildKpiDetailHtml(rows, summary)}`;
  }

  function buildKpiDetailHtml(rows, summary) {
    const allRows = rows || [];
    const loggedInRows = allRows.filter(row => row.lastLoginDate);
    const neverLoggedRows = allRows.filter(row => !row.lastLoginDate);
    const staleRows = allRows.filter(row => row.stale);

    return `
<div class="kpi-detail-panel" id="kpiDetailPanel">
  <div class="kpi-detail-empty" id="kpiDetailEmpty">Select a KPI card to review the matching employees, role summary, or department summary.</div>
  ${buildKpiEmployeePanelHtml({
    id: 'kpiPanel_shown',
    title: 'Employees Shown',
    subtitle: formatWholeNumber(allRows.length) + ' employee row(s) in the current filters',
    filename: 'kpi_employees_shown.csv',
    rows: allRows
  })}
  ${buildKpiEmployeePanelHtml({
    id: 'kpiPanel_logged',
    title: 'Logged In',
    subtitle: formatWholeNumber(loggedInRows.length) + ' employee(s) with at least one successful login',
    filename: 'kpi_logged_in_employees.csv',
    rows: loggedInRows
  })}
  ${buildKpiEmployeePanelHtml({
    id: 'kpiPanel_never',
    title: 'Never Logged In',
    subtitle: formatWholeNumber(neverLoggedRows.length) + ' employee(s) without a successful login in the current result set',
    filename: 'kpi_never_logged_in_employees.csv',
    rows: neverLoggedRows
  })}
  ${buildKpiEmployeePanelHtml({
    id: 'kpiPanel_stale',
    title: 'Stale / No Login',
    subtitle: formatWholeNumber(staleRows.length) + ' employee(s) with no login or ' + summary.staleDays + '+ days since last login',
    filename: 'kpi_stale_or_no_login_employees.csv',
    rows: staleRows
  })}
  ${buildKpiRoleSummaryPanelHtml(allRows)}
  ${buildKpiDepartmentSummaryPanelHtml(allRows)}
</div>`;
  }

  function buildKpiEmployeePanelHtml(options) {
    const rows = options.rows || [];
    const tableId = options.id + 'Table';

    return `
<div class="kpi-panel-section" id="${escAttr(options.id)}" style="display:none">
  <div class="today-role-detail-head">
    <div>
      <b>${esc(options.title)}</b>
      <span>${esc(options.subtitle)}</span>
    </div>
    <button type="button" class="btn btn-small" onclick="exportTableCsv('${escAttr(tableId)}', '${escAttr(options.filename)}')">Export CSV</button>
  </div>
  ${rows.length ? buildKpiEmployeeTableHtml(tableId, rows) : '<div class="empty-chart">No employees matched this KPI in the current result set.</div>'}
</div>`;
  }

  function buildKpiEmployeeTableHtml(tableId, rows) {
    return `
<div class="kpi-table-scroll">
  <table class="kpi-employee-table" id="${escAttr(tableId)}">
    <thead>
      <tr>
        <th>Employee</th>
        <th>Email</th>
        <th>Department</th>
        <th>Role Name</th>
        <th>Last Login Date / Time</th>
        <th>Days Since Login</th>
        <th>Employee Status</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map(buildKpiEmployeeTableRowHtml).join('')}
    </tbody>
  </table>
</div>`;
  }

  function buildKpiEmployeeTableRowHtml(row) {
    const status = getEmployeeStatus(row);

    return `
<tr>
  <td data-export-label="${escAttr(row.name || '')}">${buildEmployeeLink(row)}</td>
  <td>${esc(row.email)}</td>
  <td>${esc(getDepartmentName(row))}</td>
  <td>${esc(row.roleName || 'No successful login role')}</td>
  <td>${esc(row.lastLogin || 'Never logged in')}</td>
  <td>${esc(row.loginAgeLabel)}</td>
  <td><span class="status-pill ${escAttr(status.className)}">${esc(status.text)}</span></td>
</tr>`;
  }

  function buildKpiRoleSummaryPanelHtml(rows) {
    const roleRows = buildKpiRoleSummaryRows(rows);
    const tableId = 'kpiRoleSummaryTable';

    return `
<div class="kpi-panel-section" id="kpiPanel_roles" style="display:none">
  <div class="today-role-detail-head">
    <div>
      <b>Roles Seen</b>
      <span>${esc(formatWholeNumber(roleRows.length))} login role(s) represented in the current employee rows</span>
    </div>
    <button type="button" class="btn btn-small" onclick="exportTableCsv('${tableId}', 'kpi_role_summary.csv')">Export CSV</button>
  </div>
  ${roleRows.length ? buildKpiRoleSummaryTableHtml(tableId, roleRows) : '<div class="empty-chart">No successful login roles were found in the current result set.</div>'}
</div>`;
  }

  function buildKpiRoleSummaryRows(rows) {
    const roleMap = {};

    (rows || []).forEach(row => {
      const roleName = row.roleName || '';
      if (!roleName) return;

      if (!roleMap[roleName]) {
        roleMap[roleName] = {
          roleName,
          total: 0,
          loggedIn: 0,
          stale: 0,
          neverLogged: 0
        };
      }

      roleMap[roleName].total += 1;
      if (row.lastLoginDate) roleMap[roleName].loggedIn += 1;
      if (row.stale) roleMap[roleName].stale += 1;
      if (!row.lastLoginDate) roleMap[roleName].neverLogged += 1;
    });

    return Object.keys(roleMap)
      .map(roleName => roleMap[roleName])
      .sort((a, b) => b.total - a.total || a.roleName.localeCompare(b.roleName));
  }

  function buildKpiRoleSummaryTableHtml(tableId, roleRows) {
    return `
<div class="kpi-table-scroll">
  <table class="kpi-role-summary-table" id="${escAttr(tableId)}">
    <thead>
      <tr>
        <th>Role</th>
        <th>Employees Shown</th>
        <th>Logged In</th>
        <th>Stale / No Login</th>
      </tr>
    </thead>
    <tbody>
      ${roleRows.map((role, index) => `
        <tr>
          <td>${buildRoleTileLabelHtml(role.roleName, getRoleColor(index))}</td>
          <td>${esc(formatWholeNumber(role.total))}</td>
          <td>${esc(formatWholeNumber(role.loggedIn))}</td>
          <td>${esc(formatWholeNumber(role.stale))}</td>
        </tr>`).join('')}
    </tbody>
  </table>
</div>`;
  }

  function buildKpiDepartmentSummaryPanelHtml(rows) {
    const departmentRows = buildKpiDepartmentSummaryRows(rows);
    const tableId = 'kpiDepartmentSummaryTable';

    return `
<div class="kpi-panel-section" id="kpiPanel_departments" style="display:none">
  <div class="today-role-detail-head">
    <div>
      <b>Department Wise Summary</b>
      <span>${esc(formatWholeNumber(departmentRows.length))} department bucket(s) represented in the current employee rows</span>
    </div>
    <button type="button" class="btn btn-small" onclick="exportTableCsv('${tableId}', 'kpi_department_summary.csv')">Export CSV</button>
  </div>
  ${departmentRows.length ? buildKpiDepartmentSummaryTableHtml(tableId, departmentRows) : '<div class="empty-chart">No departments were found in the current result set.</div>'}
</div>`;
  }

  function buildKpiDepartmentSummaryRows(rows) {
    const departmentMap = {};

    (rows || []).forEach(row => {
      const departmentName = getDepartmentName(row);

      if (!departmentMap[departmentName]) {
        departmentMap[departmentName] = {
          departmentName,
          total: 0,
          loggedIn: 0,
          stale: 0,
          neverLogged: 0,
          inactive: 0
        };
      }

      departmentMap[departmentName].total += 1;
      if (row.lastLoginDate) departmentMap[departmentName].loggedIn += 1;
      if (row.stale) departmentMap[departmentName].stale += 1;
      if (!row.lastLoginDate) departmentMap[departmentName].neverLogged += 1;
      if (row.inactive) departmentMap[departmentName].inactive += 1;
    });

    return Object.keys(departmentMap)
      .map(departmentName => departmentMap[departmentName])
      .sort((a, b) => b.total - a.total || a.departmentName.localeCompare(b.departmentName));
  }

  function buildKpiDepartmentSummaryTableHtml(tableId, departmentRows) {
    return `
<div class="kpi-table-scroll">
  <table class="kpi-department-summary-table" id="${escAttr(tableId)}">
    <thead>
      <tr>
        <th>Department</th>
        <th>Employees Shown</th>
        <th>Logged In</th>
        <th>Stale / No Login</th>
        <th>Never Logged In</th>
        <th>Inactive</th>
      </tr>
    </thead>
    <tbody>
      ${departmentRows.map((department, index) => `
        <tr>
          <td><span class="role-swatch" style="background:${escAttr(getRoleColor(index))}"></span>${esc(department.departmentName)}</td>
          <td>${esc(formatWholeNumber(department.total))}</td>
          <td>${esc(formatWholeNumber(department.loggedIn))}</td>
          <td>${esc(formatWholeNumber(department.stale))}</td>
          <td>${esc(formatWholeNumber(department.neverLogged))}</td>
          <td>${esc(formatWholeNumber(department.inactive))}</td>
        </tr>`).join('')}
    </tbody>
  </table>
</div>`;
  }

  function buildDepartmentDistributionTileHtml(rows) {
    const allRows = rows || [];
    const sourceRows = buildKpiDepartmentSummaryRows(allRows);
    const totalEmployees = sourceRows.reduce((sum, row) => sum + Number(row.total || 0), 0);
    const departmentRows = buildDepartmentDistributionRows(sourceRows, 10);

    return `
<section class="panel department-distribution-panel">
  <div class="panel-head">
    <div>
      <h2>Employees by Department</h2>
      <span>${esc(formatWholeNumber(totalEmployees))} employee(s) across ${esc(formatWholeNumber(sourceRows.length))} department bucket(s) | Top 10 ranking</span>
    </div>
    <button type="button" class="btn btn-small" onclick="exportTableCsv('departmentDistributionTable', 'employees_by_department.csv')">Export CSV</button>
  </div>
  ${departmentRows.length ? `
    <div class="department-distribution-body">
      <div class="department-donut-wrap">
        ${buildDepartmentDonutSvg(departmentRows, totalEmployees)}
      </div>
      ${buildDepartmentRankingTableHtml(departmentRows)}
    </div>
    ${buildDepartmentEmployeeDetailHtml(departmentRows, allRows)}` : '<div class="empty-chart">No department data found in the current result set.</div>'}
</section>`;
  }

  function buildDepartmentDistributionRows(sourceRows, limit) {
    const totalEmployees = (sourceRows || []).reduce((sum, row) => sum + Number(row.total || 0), 0);
    const visibleLimit = Math.max(1, Number(limit || 10));
    const visibleRows = (sourceRows || []).slice(0, visibleLimit);
    const hiddenRows = (sourceRows || []).slice(visibleLimit);

    if (hiddenRows.length) {
      visibleRows.push({
        departmentName: 'Other Departments',
        total: hiddenRows.reduce((sum, row) => sum + Number(row.total || 0), 0),
        loggedIn: hiddenRows.reduce((sum, row) => sum + Number(row.loggedIn || 0), 0),
        stale: hiddenRows.reduce((sum, row) => sum + Number(row.stale || 0), 0),
        neverLogged: hiddenRows.reduce((sum, row) => sum + Number(row.neverLogged || 0), 0),
        inactive: hiddenRows.reduce((sum, row) => sum + Number(row.inactive || 0), 0),
        hiddenDepartmentNames: hiddenRows.map(row => row.departmentName)
      });
    }

    return visibleRows.map((row, index) => {
      const count = Number(row.total || 0);

      return Object.assign({}, row, {
        rank: index + 1,
        color: getRoleColor(index),
        percentage: totalEmployees ? (count / totalEmployees) * 100 : 0
      });
    }).filter(row => Number(row.total || 0) > 0);
  }

  function buildDepartmentDonutSvg(departmentRows, totalEmployees) {
    const size = 260;
    const center = size / 2;
    const radius = 76;
    const strokeWidth = 34;
    const circumference = 2 * Math.PI * radius;
    let offset = 0;

    const segments = (departmentRows || []).map(row => {
      const value = Number(row.total || 0);
      const dash = totalEmployees ? (value / totalEmployees) * circumference : 0;
      const gap = Math.max(0, circumference - dash);
      const segmentOffset = -offset;
      const title = row.departmentName + ': ' + formatWholeNumber(value) + ' employee(s), ' + formatOneDecimal(row.percentage) + '%';
      offset += dash;

      return `<circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="${escAttr(row.color)}" stroke-width="${strokeWidth}" stroke-dasharray="${roundSvgNumber(dash)} ${roundSvgNumber(gap)}" stroke-dashoffset="${roundSvgNumber(segmentOffset)}" transform="rotate(-90 ${center} ${center})" class="department-donut-segment">
        <title>${escAttr(title)}</title>
      </circle>`;
    }).join('');

    let labelOffset = 0;
    const labels = (departmentRows || []).map(row => {
      const value = Number(row.total || 0);
      const dash = totalEmployees ? (value / totalEmployees) * circumference : 0;
      const percentage = Number(row.percentage || 0);
      const midRatio = (labelOffset + (dash / 2)) / circumference;
      const labelAngle = (midRatio * Math.PI * 2) - (Math.PI / 2);
      const labelRadius = 93;
      const x = center + (Math.cos(labelAngle) * labelRadius);
      const y = center + (Math.sin(labelAngle) * labelRadius);
      labelOffset += dash;

      if (percentage < 4) return '';

      return `<text x="${roundSvgNumber(x)}" y="${roundSvgNumber(y)}" text-anchor="middle" dominant-baseline="middle" class="department-donut-label">${esc(formatOneDecimal(percentage))}%</text>`;
    }).join('');

    return `
<svg class="department-donut-svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="Employee count by department">
  <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="#e5e7eb" stroke-width="${strokeWidth}" class="department-donut-bg"></circle>
  ${segments}
  ${labels}
  <circle cx="${center}" cy="${center}" r="48" class="department-donut-hole"></circle>
  <text x="${center}" y="${center - 4}" text-anchor="middle" class="department-donut-total">${esc(formatWholeNumber(totalEmployees))}</text>
  <text x="${center}" y="${center + 17}" text-anchor="middle" class="department-donut-caption">Employees</text>
</svg>`;
  }

  function buildDepartmentRankingTableHtml(departmentRows) {
    return `
<div class="department-ranking-table-wrap">
  <table class="department-ranking-table" id="departmentDistributionTable">
    <thead>
      <tr>
        <th>Rank</th>
        <th>Department</th>
        <th>Employees</th>
        <th>Share</th>
        <th>Logged In</th>
        <th>Stale / No Login</th>
      </tr>
    </thead>
    <tbody>
      ${(departmentRows || []).map((row, index) => `
        <tr data-department-index="${escAttr(index)}">
          <td><span class="department-rank-chip" style="background:${escAttr(row.color)}">${esc(row.rank)}</span></td>
          <td data-export-label="${escAttr(row.departmentName)}">
            <button type="button" class="department-rank-name department-drilldown-button" onclick="showDepartmentEmployees(${index})" aria-label="${escAttr('Show employees for ' + row.departmentName)}">
              <span class="department-rank-dot" style="background:${escAttr(row.color)}"></span>${esc(row.departmentName)}
            </button>
          </td>
          <td data-export-label="${escAttr(formatWholeNumber(row.total))}">
            <button type="button" class="department-count-button" onclick="showDepartmentEmployees(${index})" aria-label="${escAttr('Show ' + formatWholeNumber(row.total) + ' employees for ' + row.departmentName)}">${esc(formatWholeNumber(row.total))}</button>
          </td>
          <td>${esc(formatOneDecimal(row.percentage))}%</td>
          <td>${esc(formatWholeNumber(row.loggedIn))}</td>
          <td>${esc(formatWholeNumber(row.stale))}</td>
        </tr>`).join('')}
    </tbody>
  </table>
</div>`;
  }

  function buildDepartmentEmployeeDetailHtml(departmentRows, rows) {
    return `
<div class="department-employee-detail" id="departmentEmployeeDetail">
  <div class="department-employee-detail-empty" id="departmentEmployeeDetailEmpty">Select a department row to view matching employees.</div>
  ${(departmentRows || []).map((department, index) => {
    const employeeRows = buildDepartmentEmployeeRows(department, rows);
    const tableId = 'departmentEmployeeTable' + index;
    const panelId = 'departmentEmployees' + index;
    const filename = 'department_employees_' + department.departmentName;

    return `
      <div class="department-employee-panel" id="${escAttr(panelId)}" style="display:none">
        <div class="today-role-detail-head">
          <div>
            <b>${esc(department.departmentName)}</b>
            <span>${esc(formatWholeNumber(employeeRows.length))} employee(s) in this department from current filters</span>
          </div>
          <button type="button" class="btn btn-small" onclick="exportTableCsv('${escAttr(tableId)}', '${escAttr(filename)}')">Export CSV</button>
        </div>
        ${employeeRows.length ? buildKpiEmployeeTableHtml(tableId, employeeRows) : '<div class="empty-chart">No employees matched this department in the current result set.</div>'}
      </div>`;
  }).join('')}
</div>`;
  }

  function buildDepartmentEmployeeRows(department, rows) {
    const hiddenDepartmentMap = {};

    (department.hiddenDepartmentNames || []).forEach(name => {
      hiddenDepartmentMap[String(name || '')] = true;
    });

    return (rows || []).filter(row => {
      const departmentName = getDepartmentName(row);

      if (department.departmentName === 'Other Departments') {
        return !!hiddenDepartmentMap[departmentName];
      }

      return departmentName === department.departmentName;
    }).slice().sort(compareEmployeeRows);
  }

  function buildTodayRoleTrendHtml(trend, filters) {
    const roleCount = trend && trend.roles ? trend.roles.length : 0;
    const hiddenRoleText = trend && trend.hiddenRoleCount ?
      ' | ' + trend.hiddenRoleCount + ' lower-volume role(s) grouped as Other PSiQ/Admin Roles' :
      '';
    const roleFilterText = filters.roleText ? ' | table role filter not applied to chart' : '';

    return `
<section class="panel today-role-panel">
  <div class="panel-head">
    <div>
      <h2>Today Login by Role</h2>
      <span>${esc(trend.dateLabel || 'Today')} | ${esc(trend.total || 0)} unique employee(s) logged in successfully today | PSiQ + Administrator roles${esc(roleFilterText)}${esc(hiddenRoleText)}</span>
    </div>
  </div>
  ${roleCount ? buildTodayRoleChartSvg(trend) + buildTodayRoleEmployeeDetailHtml(trend) : '<div class="empty-chart">No successful employee logins found for today.</div>'}
</section>`;
  }

  function buildTodayRoleChartSvg(trend) {
    const roles = trend.roles || [];
    const width = 1040;
    const left = 302;
    const right = 82;
    const top = 86;
    const bottom = 38;
    const rowHeight = 34;
    const barHeight = 18;
    const height = top + (Math.max(1, roles.length) * rowHeight) + bottom;
    const plotWidth = width - left - right;
    const max = Math.max(1, Number(trend.maxRoleCount || 1));
    const guideHeight = Math.max(rowHeight, roles.length * rowHeight);
    const grid = [0, 0.5, 1].map(p => {
      const x = left + (plotWidth * p);
      const label = Math.round(max * p);

      return `
      <line x1="${roundSvgNumber(x)}" y1="${top - 12}" x2="${roundSvgNumber(x)}" y2="${top + guideHeight - 8}" class="today-role-grid"></line>
      <text x="${roundSvgNumber(x)}" y="${top - 22}" text-anchor="middle" class="today-role-axis">${label}</text>`;
    }).join('');
    const bars = roles.map((role, index) => {
      const value = Number(role.count || 0);
      const y = top + (index * rowHeight);
      const barY = y + ((rowHeight - barHeight) / 2);
      const barWidth = value ? Math.max(6, Math.round((value / max) * plotWidth)) : 0;
      const label = truncateText(role.roleName, 42);
      const countInside = barWidth > 48;
      const countX = countInside ? left + barWidth - 10 : Math.min(width - right + 44, left + barWidth + 10);
      const countClass = countInside ? 'today-role-count inside' : 'today-role-count';

      return `
      <g class="today-role-row" data-role-index="${index}" role="button" tabindex="0" focusable="true" onclick="showTodayRoleEmployees(${index})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();showTodayRoleEmployees(${index});}">
        <text x="${left - 16}" y="${roundSvgNumber(y + 22)}" text-anchor="end" class="today-role-row-label">
          <title>${escAttr(role.roleName)}</title>${esc(label)}
        </text>
        <rect x="${left}" y="${roundSvgNumber(barY)}" width="${roundSvgNumber(barWidth)}" height="${barHeight}" rx="5" class="today-role-bar" fill="${escAttr(role.color)}">
          <title>${escAttr(role.roleName)}: ${escAttr(value)} employee(s) today</title>
        </rect>
        <text x="${roundSvgNumber(countX)}" y="${roundSvgNumber(y + 22)}" text-anchor="${countInside ? 'end' : 'start'}" class="${countClass}">${esc(value)}</text>
      </g>`;
    }).join('');

    return `
<div class="today-role-chart-wrap">
  <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Today employee logins by role">
    <defs>
      <linearGradient id="todayRoleBackground" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#f8fcff"></stop>
        <stop offset="52%" stop-color="#ecfeff"></stop>
        <stop offset="100%" stop-color="#fff7ed"></stop>
      </linearGradient>
      <linearGradient id="todayRoleWave" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#2563eb" stop-opacity=".12"></stop>
        <stop offset="52%" stop-color="#14b8a6" stop-opacity=".12"></stop>
        <stop offset="100%" stop-color="#f97316" stop-opacity=".14"></stop>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${width}" height="${height}" rx="14" class="today-role-bg"></rect>
    <path d="M 0 ${height - 72} C 150 ${height - 90} 262 ${height - 50} 410 ${height - 74} C 570 ${height - 100} 762 ${height - 96} 1040 ${height - 72} L 1040 ${height} L 0 ${height} Z" class="today-role-wave"></path>
    <circle cx="376" cy="28" r="4" class="today-role-legend-dot"></circle>
    <text x="390" y="32" class="today-role-legend">Employees Logged In Today - Ranked by Role</text>
    ${grid}
    ${bars}
  </svg>
</div>`;
  }

  function buildTodayRoleEmployeeDetailHtml(trend) {
    const roles = trend.roles || [];

    return `
<div class="today-role-detail" id="todayRoleDetail" data-snapshot-key="${escAttr(trend.dateKey || 'today')}">
  <div class="today-role-detail-empty" id="todayRoleDetailEmpty">Select a role bar to view employee names.</div>
  ${roles.map((role, index) => buildTodayRoleEmployeePanelHtml(role, index, trend)).join('')}
</div>`;
  }

  function buildTodayRoleEmployeePanelHtml(role, index, trend) {
    const employees = role.employees || [];
    const panelId = 'todayRoleEmployees' + index;
    const exportTitle = 'today_role_logins_' + (trend.dateKey || 'today') + '_' + role.roleName;

    return `
<div class="today-role-employee-list" id="${panelId}" data-export-title="${escAttr(exportTitle)}" data-export-period="${escAttr(trend.dateLabel || 'Today')}" data-export-role="${escAttr(role.roleName)}" style="display:none">
  <div class="today-role-detail-head">
    <div>
      <b>${esc(role.roleName)}</b>
      <span>${esc(formatWholeNumber(role.count))} employee(s) logged in today</span>
    </div>
    <button type="button" class="btn btn-small" onclick="exportEmployeePanelCsv('${panelId}')">Export CSV</button>
  </div>
  <div class="today-role-employee-grid">
    ${employees.length ? employees.map(buildTodayRoleEmployeeItemHtml).join('') : '<span class="today-role-no-employees">Employee names are not available for this role from the current search result.</span>'}
  </div>
</div>`;
  }

  function buildTodayRoleEmployeeItemHtml(employee) {
    const name = employee.name || employee.email || 'Unnamed employee';
    const weekendLogin = !!employee.weekendLogin;
    const weekendLabel = employee.weekendLoginLabel || 'Weekend';
    const dashboardDeveloper = isDashboardDeveloperEmployee({
      name,
      email: employee.email
    });

    return `
<button type="button" class="today-role-employee employee-export-row${weekendLogin ? ' weekend-login-member' : ''}${dashboardDeveloper ? ' dashboard-developer-member' : ''}" data-employee-id="${escAttr(employee.id || employee.email || name)}" data-employee-name="${escAttr(name)}" data-employee-email="${escAttr(employee.email || '')}" data-employee-department="${escAttr(employee.department || 'No Department')}" data-employee-last-login="${escAttr(employee.lastLogin || 'Not available')}" data-weekend-login="${weekendLogin ? 'T' : 'F'}" data-weekend-login-label="${escAttr(weekendLogin ? weekendLabel : '')}" data-dashboard-developer="${dashboardDeveloper ? 'T' : 'F'}" data-employee-url="${escAttr(employee.employeeUrl || '')}" onclick="openEmployeeLoginPopup(this)">
  <b>${esc(name)}</b>
  ${employee.email ? `<small>${esc(employee.email)}</small>` : ''}
  ${dashboardDeveloper ? buildDeveloperAdminBadgeHtml(true) : ''}
  ${weekendLogin ? `<span class="weekend-login-badge">${esc(weekendLabel)}</span>` : ''}
</button>`;
  }

  function buildEmployeeLoginPopupHtml() {
    return `
<div id="employeeLoginPopup" class="employee-popup-backdrop" aria-hidden="true">
  <div class="employee-popup" role="dialog" aria-modal="true" aria-labelledby="employeePopupName">
    <div class="employee-popup-head">
      <div>
        <h2 id="employeePopupName">Employee Login Detail</h2>
        <span id="employeePopupEmail"></span>
        <span id="employeePopupDeveloperBadge" class="developer-popup-badge" style="display:none">${buildDeveloperAdminBadgeHtml(false)}</span>
      </div>
      <button type="button" class="employee-popup-close" onclick="closeEmployeeLoginPopup()" aria-label="Close employee detail">x</button>
    </div>
    <div class="employee-popup-body">
      <div class="employee-popup-row">
        <span>Last Login Date / Time</span>
        <b id="employeePopupLastLogin"></b>
      </div>
      <div class="employee-popup-row">
        <span>Weekend Login</span>
        <b id="employeePopupWeekendLogin"></b>
      </div>
      <div class="employee-popup-row">
        <span>Department</span>
        <b id="employeePopupDepartment"></b>
      </div>
      <div class="employee-popup-row">
        <span>Role</span>
        <b id="employeePopupRole"></b>
      </div>
      <div class="employee-popup-row">
        <span>Period</span>
        <b id="employeePopupPeriod"></b>
      </div>
    </div>
    <a id="employeePopupRecordLink" class="employee-popup-link" href="#" target="_blank" rel="noopener">Open Employee Record</a>
  </div>
</div>`;
  }

  function buildMonthlyRoleTrendHtml(trend, filters) {
    const roleCount = trend && trend.roles ? trend.roles.length : 0;
    const hiddenRoleText = trend && trend.hiddenRoleCount ?
      ' | chart shows top ' + CONFIG.monthlyChartRoleLimit + ' role(s); ' + trend.hiddenRoleCount + ' lower-volume role(s) grouped as Other PSiQ/Admin Roles' :
      '';
    const roleFilterText = filters.roleText ? ' | table role filter not applied to chart' : '';

    return `
<section class="panel role-trend-panel">
  <div class="panel-head">
    <div>
      <h2>Role Wise Monthly Login Trend</h2>
      <span>Unique employees with successful login, grouped by PSiQ + Administrator login role and month | Last ${esc(filters.chartMonths)} month(s)${esc(roleFilterText)}${esc(hiddenRoleText)}</span>
    </div>
  </div>
  ${roleCount ? buildMonthlyRoleChartSvg(trend) : '<div class="empty-chart">No monthly login data found for the selected filters.</div>'}
  ${roleCount ? buildMonthlyRoleMatrixHtml(trend) : ''}
  ${roleCount ? buildMonthlyRoleEmployeeDetailHtml(trend) : ''}
</section>`;
  }

  function buildMonthlyRoleChartSvg(trend) {
    const width = 1040;
    const height = 420;
    const left = 64;
    const right = 26;
    const top = 38;
    const bottom = 112;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const months = trend.months || [];
    const roles = trend.roles || [];
    const count = Math.max(1, months.length);
    const slot = plotWidth / count;
    const barWidth = Math.max(24, Math.min(56, slot * 0.56));
    const baseline = top + plotHeight;
    const max = Math.max(1, Number(trend.maxMonthTotal || 1));
    const labelEvery = count > 14 ? Math.ceil(count / 12) : 1;

    const grid = [0, 0.25, 0.5, 0.75, 1].map(p => {
      const y = top + plotHeight - (plotHeight * p);
      const label = Math.round(max * p);
      return `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" class="grid-line"></line><text x="16" y="${y + 4}" class="axis-label">${label}</text>`;
    }).join('');
    const monthHighlights = months.map((month, monthIndex) => {
      const x = left + (slot * monthIndex) + ((slot - barWidth) / 2);

      return `<rect x="${roundSvgNumber(x - 8)}" y="${top - 10}" width="${roundSvgNumber(barWidth + 16)}" height="${roundSvgNumber(plotHeight + 20)}" rx="8" class="monthly-role-month-highlight" data-month-index="${monthIndex}">
        <title>${escAttr(month.title)}</title>
      </rect>`;
    }).join('');
    const totalLinePoints = months.map((month, monthIndex) => {
      const value = Number(month.total || 0);
      return {
        x: left + (slot * monthIndex) + (slot / 2),
        y: baseline - ((value / max) * plotHeight),
        value,
        title: month.title
      };
    });
    const totalLinePointText = totalLinePoints.map(point => {
      return roundSvgNumber(point.x) + ',' + roundSvgNumber(point.y);
    }).join(' ');
    const totalTrendLine = totalLinePoints.length > 1 ? `
    <polyline points="${escAttr(totalLinePointText)}" class="monthly-total-line-shadow"></polyline>
    <polyline points="${escAttr(totalLinePointText)}" class="monthly-total-line"></polyline>
    ${totalLinePoints.map(point => `
      <g class="monthly-total-point">
        <title>${escAttr(point.title + ': ' + formatWholeNumber(point.value) + ' total employee logins')}</title>
        <circle cx="${roundSvgNumber(point.x)}" cy="${roundSvgNumber(point.y)}" r="4.5" class="monthly-total-point-ring"></circle>
        <circle cx="${roundSvgNumber(point.x)}" cy="${roundSvgNumber(point.y)}" r="2" class="monthly-total-point-core"></circle>
      </g>`).join('')}
    <g class="monthly-total-line-legend">
      <line x1="${width - right - 166}" y1="24" x2="${width - right - 126}" y2="24" class="monthly-total-line"></line>
      <circle cx="${width - right - 146}" cy="24" r="4.5" class="monthly-total-point-ring"></circle>
      <circle cx="${width - right - 146}" cy="24" r="2" class="monthly-total-point-core"></circle>
      <text x="${width - right - 116}" y="28">Total trend</text>
    </g>` : '';

    const bars = months.map((month, monthIndex) => {
      const x = left + (slot * monthIndex) + ((slot - barWidth) / 2);
      let yCursor = baseline;
      const segments = roles.map((role, roleIndex) => {
        const value = Number(role.countByMonth[month.key] || 0);
        if (!value) return '';

        const segmentHeight = Math.max(4, Math.round((value / max) * plotHeight));
        const highlightHeight = Math.min(7, segmentHeight);
        const tooltip = month.title + ' | ' + role.roleName + ': ' + value + ' employee(s). Click to view employees.';
        yCursor -= segmentHeight;

        return `<g class="monthly-role-segment" data-role-index="${roleIndex}" data-month-index="${monthIndex}" role="button" tabindex="0" focusable="true" onclick="showMonthlyRoleEmployees(${roleIndex}, ${monthIndex})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();showMonthlyRoleEmployees(${roleIndex}, ${monthIndex});}">
          <rect x="${roundSvgNumber(x - 3)}" y="${roundSvgNumber(yCursor - 3)}" width="${roundSvgNumber(barWidth + 6)}" height="${roundSvgNumber(segmentHeight + 6)}" rx="5" class="monthly-role-selection"></rect>
          <rect x="${roundSvgNumber(x)}" y="${roundSvgNumber(yCursor)}" width="${roundSvgNumber(barWidth)}" height="${segmentHeight}" fill="${escAttr(role.color)}" rx="3" class="monthly-role-rect">
            <title>${escAttr(tooltip)}</title>
          </rect>
          <rect x="${roundSvgNumber(x)}" y="${roundSvgNumber(yCursor)}" width="${roundSvgNumber(barWidth)}" height="${roundSvgNumber(highlightHeight)}" rx="3" class="monthly-role-highlight"></rect>
        </g>`;
      }).join('');
      const labelX = left + (slot * monthIndex) + (slot / 2);
      const showLabel = monthIndex === 0 || monthIndex === count - 1 || monthIndex % labelEvery === 0;
      const totalLabel = month.total > 0 ?
        `<text x="${roundSvgNumber(labelX)}" y="${roundSvgNumber(Math.max(top + 12, yCursor - 7))}" text-anchor="middle" class="bar-total-label">${month.total}</text>` :
        '';
      const axisLabel = showLabel ?
        `<text x="${roundSvgNumber(labelX)}" y="${height - 52}" text-anchor="middle" class="axis-label month-axis-label">${esc(month.label)}</text>` :
        '';

      return segments + totalLabel + axisLabel;
    }).join('');

    return `
<div class="role-chart-wrap">
  ${buildMonthlyRoleLegendHtml(roles)}
  <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Role wise monthly employee login counts">
    <defs>
      <linearGradient id="roleTrendBackground" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#f8fbff"></stop>
        <stop offset="48%" stop-color="#eefaf7"></stop>
        <stop offset="100%" stop-color="#fff7ed"></stop>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${width}" height="${height}" rx="14" class="role-chart-bg"></rect>
    ${monthHighlights}
    ${grid}
    ${bars}
    ${totalTrendLine}
    <line x1="${left}" y1="${baseline}" x2="${width - right}" y2="${baseline}" class="axis-line"></line>
  </svg>
</div>`;
  }

  function buildMonthlyRoleEmployeeDetailHtml(trend) {
    const months = trend.months || [];
    const roles = trend.roles || [];
    const detailRoles = trend.detailRoles || roles;

    return `
<div class="monthly-role-detail" id="monthlyRoleDetail">
  <div class="monthly-role-detail-empty" id="monthlyRoleDetailEmpty">Select a monthly chart segment or matrix number to view employee names.</div>
  ${roles.map((role, roleIndex) => {
    return months.map((month, monthIndex) => buildMonthlyRoleEmployeePanelHtml(role, month, roleIndex, monthIndex)).join('');
  }).join('')}
  ${detailRoles.map((role, roleIndex) => {
    return months.map((month, monthIndex) => buildMonthlyRoleEmployeePanelHtml(role, month, roleIndex, monthIndex, 'monthlyMatrixEmployees')).join('');
  }).join('')}
</div>`;
  }

  function buildMonthlyRoleEmployeePanelHtml(role, month, roleIndex, monthIndex, panelPrefix) {
    const count = Number(role.countByMonth[month.key] || 0);
    if (!count) return '';

    const employees = ((role.employeesByMonth && role.employeesByMonth[month.key]) || []);
    const prefix = panelPrefix || 'monthlyRoleEmployees';
    const panelId = prefix + roleIndex + '_' + monthIndex;
    const exportTitle = 'monthly_role_logins_' + month.key + '_' + role.roleName;

    return `
<div class="monthly-role-employee-list" id="${panelId}" data-export-title="${escAttr(exportTitle)}" data-export-period="${escAttr(month.title)}" data-export-role="${escAttr(role.roleName)}" style="display:none">
  <div class="today-role-detail-head">
    <div>
      <b>${esc(role.roleName)}</b>
      <span>${esc(formatWholeNumber(count))} employee(s) logged in during ${esc(month.title)}</span>
    </div>
    <button type="button" class="btn btn-small" onclick="exportEmployeePanelCsv('${panelId}')">Export CSV</button>
  </div>
  <div class="today-role-employee-grid monthly-role-employee-grid">
    ${employees.length ? employees.map(buildTodayRoleEmployeeItemHtml).join('') : '<span class="today-role-no-employees">Employee names are not available for this role/month from the current search result.</span>'}
  </div>
</div>`;
  }

  function buildMonthlyRoleLegendHtml(roles) {
    return `<div class="role-legend">${roles.map(role => `
      <span class="role-legend-item" style="${escAttr(getRoleLegendTileStyle(role.color))}" title="${escAttr(role.roleName + ': ' + formatWholeNumber(role.total) + ' employee-month total')}">
        <span class="role-legend-dot" style="background:${escAttr(role.color)}"></span>
        <small>${esc(formatWholeNumber(role.total))}</small>
        <b>${esc(truncateText(role.roleName, 34))}</b>
      </span>`).join('')}</div>`;
  }

  function getRoleLegendTileStyle(roleColor) {
    return getRoleTileStyle(roleColor, 0.05, 0.16, 0.22, 3, 0.32);
  }

  function buildRoleTileLabelHtml(label, roleColor) {
    const color = normalizeHexColor(roleColor, '#64748b');

    return `<span class="role-tile-label" style="${escAttr(getRoleTileStyle(color, 0.04, 0.14, 0.2, 3, 0.28))}">
      <span class="role-tile-dot" style="background:${escAttr(color)}"></span>
      <span class="role-tile-text">${esc(label)}</span>
    </span>`;
  }

  function getRoleTileStyle(roleColor, startMix, endMix, borderMix, stripeWidth, stripeOpacity) {
    const color = normalizeHexColor(roleColor, '#64748b');
    const softStart = mixHexColors('#ffffff', color, startMix);
    const softEnd = mixHexColors('#ffffff', color, endMix);
    const borderColor = mixHexColors('#e2e8f0', color, borderMix);
    const rgb = hexToRgb(color);
    const opacity = Math.max(0, Math.min(1, Number(stripeOpacity || 0.28)));

    return 'background:linear-gradient(135deg,' + softStart + ' 0%,' + softEnd + ' 100%);' +
      'border-color:' + borderColor + ';' +
      'box-shadow:inset ' + Number(stripeWidth || 3) + 'px 0 0 rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + opacity + ')';
  }

  function buildMonthlyRoleMatrixHtml(trend) {
    const months = trend.months || [];
    const roles = trend.detailRoles || trend.roles || [];
    const monthCount = Math.max(1, months.length);
    const maxMatrixCellValue = getMaxMonthlyRoleMatrixValue(roles, months);

    return `
<div class="role-matrix-head">
  <div>
    <b>Monthly Role Matrix</b>
    <span>Totals are employee-month counts; Avg / Month is the average monthly unique employee count.</span>
  </div>
  <div class="role-matrix-actions">
    <button type="button" class="btn btn-small btn-primary" onclick="refreshLoginReport()">Refresh Report</button>
    <button type="button" class="btn btn-small" onclick="exportTableCsv('monthlyRoleMatrixTable', 'monthly_role_employee_month_matrix.csv')">Export Matrix CSV</button>
  </div>
</div>
<div class="role-matrix-scroll">
  <table class="role-matrix" id="monthlyRoleMatrixTable">
    <thead>
      <tr>
        <th>Role</th>
        ${months.map(month => `<th>${esc(month.label)}</th>`).join('')}
        <th>Avg / Month</th>
        <th>Employee-Month Total</th>
      </tr>
    </thead>
    <tbody>
      ${roles.map((role, roleIndex) => `
        <tr>
          <td>${buildRoleTileLabelHtml(role.roleName, role.color)}</td>
          ${months.map((month, monthIndex) => buildMonthlyRoleMatrixCellHtml(role, month, roleIndex, monthIndex, maxMatrixCellValue)).join('')}
          <td>${esc(formatOneDecimal(Number(role.total || 0) / monthCount))}</td>
          <td><b>${esc(formatWholeNumber(role.total))}</b></td>
        </tr>`).join('')}
    </tbody>
  </table>
</div>`;
  }

  function getMaxMonthlyRoleMatrixValue(roles, months) {
    let maxValue = 1;

    (roles || []).forEach(role => {
      (months || []).forEach(month => {
        maxValue = Math.max(maxValue, Number(role.countByMonth[month.key] || 0));
      });
    });

    return maxValue;
  }

  function buildMonthlyRoleMatrixCellHtml(role, month, roleIndex, monthIndex, maxMatrixCellValue) {
    const value = Number(role.countByMonth[month.key] || 0);
    if (!value) return '<td></td>';

    const label = role.roleName + ' | ' + month.title + ': ' + value + ' employee(s)';
    const heatmapStyle = getMonthlyMatrixHeatmapStyle(value, maxMatrixCellValue);
    const isHighestValue = value === Number(maxMatrixCellValue || 0);
    const buttonClass = 'role-matrix-count' + (isHighestValue ? ' highest-value' : '');
    const title = (isHighestValue ? 'Highest monthly count | ' : '') + label;

    return `<td>
            <button type="button" class="${escAttr(buttonClass)}" style="${escAttr(heatmapStyle)}" data-role-index="${escAttr(roleIndex)}" data-month-index="${escAttr(monthIndex)}" data-highest-value="${isHighestValue ? 'T' : 'F'}" onclick="showMonthlyMatrixEmployees(${roleIndex}, ${monthIndex})" aria-label="${escAttr('View employees for ' + title)}" title="${escAttr(title)}">${esc(formatWholeNumber(value))}</button>
          </td>`;
  }

  function getMonthlyMatrixHeatmapStyle(value, maxValue) {
    const ratio = Math.max(0, Math.min(1, Number(value || 0) / Math.max(1, Number(maxValue || 1))));
    const intensity = Math.pow(ratio, 0.38);
    const lowColor = '#f0a08d';
    const lowSoftColor = '#f8d2c6';
    const midColorBase = '#fff2cc';
    const highSoftColor = '#bfe8c4';
    const highColor = '#4fc98b';
    const startColor = intensity < 0.5 ?
      mixHexColors(lowSoftColor, midColorBase, intensity / 0.5) :
      mixHexColors(midColorBase, highSoftColor, (intensity - 0.5) / 0.5);
    const midColor = intensity < 0.5 ?
      mixHexColors(lowColor, midColorBase, intensity / 0.5) :
      mixHexColors(midColorBase, highSoftColor, (intensity - 0.5) / 0.5);
    const endColor = intensity < 0.5 ?
      mixHexColors(lowColor, midColorBase, Math.min(1, (intensity / 0.5) + 0.18)) :
      mixHexColors(midColorBase, highColor, (intensity - 0.5) / 0.5);
    const textColor = getReadableMatrixTextColor(endColor, intensity);
    const borderColor = intensity < 0.5 ?
      mixHexColors('#f4b6a7', '#f3d68a', intensity / 0.5) :
      mixHexColors('#f3d68a', '#36b37e', (intensity - 0.5) / 0.5);
    const borderRgb = hexToRgb(borderColor);

    return 'background:linear-gradient(135deg,' + startColor + ' 0%,' + midColor + ' 54%,' + endColor + ' 100%);' +
      'color:' + textColor + ';box-shadow:inset 0 0 0 1px rgba(' + borderRgb.r + ',' + borderRgb.g + ',' + borderRgb.b + ',.28)';
  }

  function normalizeHexColor(value, fallback) {
    const text = String(value || '').trim();

    if (/^#[0-9a-fA-F]{6}$/.test(text)) return text.toLowerCase();
    if (/^#[0-9a-fA-F]{3}$/.test(text)) {
      return ('#' + text.charAt(1) + text.charAt(1) + text.charAt(2) + text.charAt(2) + text.charAt(3) + text.charAt(3)).toLowerCase();
    }

    return fallback;
  }

  function mixHexColors(fromHex, toHex, amount) {
    const from = hexToRgb(fromHex);
    const to = hexToRgb(toHex);
    const ratio = Math.max(0, Math.min(1, Number(amount || 0)));

    return rgbToHex(
      Math.round(from.r + ((to.r - from.r) * ratio)),
      Math.round(from.g + ((to.g - from.g) * ratio)),
      Math.round(from.b + ((to.b - from.b) * ratio))
    );
  }

  function hexToRgb(hex) {
    const color = normalizeHexColor(hex, '#64748b').substring(1);

    return {
      r: parseInt(color.substring(0, 2), 16),
      g: parseInt(color.substring(2, 4), 16),
      b: parseInt(color.substring(4, 6), 16)
    };
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(value => {
      return Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0');
    }).join('');
  }

  function getReadableMatrixTextColor(backgroundHex, intensity) {
    if (intensity < 0.24) return '#7c2d12';
    if (intensity > 0.68) return '#065f46';

    return '#51483a';
  }

  function getColorLuminance(hex) {
    const rgb = hexToRgb(hex);
    const values = [rgb.r, rgb.g, rgb.b].map(value => {
      const channel = value / 255;
      return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
    });

    return (0.2126 * values[0]) + (0.7152 * values[1]) + (0.0722 * values[2]);
  }

  function buildResultSubtitle(data, filters) {
    const stats = data.stats || {};
    const pieces = [
      formatWholeNumber((data.rows || []).length) + ' employee row(s)',
      stats.usedLoginAccessFilter ? 'login access only' : 'all matching employees',
      filters.includeInactive ? 'inactive included' : 'active only',
      'summary rows scanned: ' + formatWholeNumber(stats.scannedSummaryRows || 0)
    ];

    if (filters.roleText) pieces.push('role contains "' + filters.roleText + '"');
    if (filters.employeeText) pieces.push('employee/email contains "' + filters.employeeText + '"');

    return pieces.join(' | ');
  }

  function buildTableHtml(rows) {
    if (!rows.length) {
      return `<div class="empty-chart">No employees matched the selected filters.</div>`;
    }

    return `
${buildDetailTableFilterHtml(rows)}
<div class="table-scroll">
  <table class="result-table" id="employeeLoginTable">
    <thead>
      <tr>
        ${buildSortableTableHeaderHtml('Employee', 'employee')}
        <th>Email</th>
        ${buildSortableTableHeaderHtml('Last Login Date / Time', 'lastLogin', 'desc')}
        ${buildSortableTableHeaderHtml('Role Name', 'role')}
        ${buildSortableTableHeaderHtml('Days Since Login', 'days')}
        ${buildSortableTableHeaderHtml('Employee Status', 'status')}
      </tr>
    </thead>
    <tbody>
      ${rows.map(buildTableRowHtml).join('')}
    </tbody>
  </table>
</div>`;
  }

  function buildSortableTableHeaderHtml(label, sortKey, initialDirection) {
    const direction = initialDirection === 'asc' || initialDirection === 'desc' ? initialDirection : '';
    const ariaSort = direction === 'asc' ? 'ascending' : (direction === 'desc' ? 'descending' : 'none');

    return `<th class="sortable" data-sort-key="${escAttr(sortKey)}" data-export-label="${escAttr(label)}" aria-sort="${escAttr(ariaSort)}">
          <button type="button" class="sort-header ${direction ? 'active' : ''}" onclick="sortEmployeeLoginTable('${escAttr(sortKey)}')" aria-label="Sort by ${escAttr(label)}">
            <span>${esc(label)}</span>
            <span class="sort-indicator ${escAttr(direction)}" data-sort-indicator="${escAttr(sortKey)}"></span>
          </button>
        </th>`;
  }

  function buildDetailTableFilterHtml(rows) {
    const roleNames = buildDetailRoleOptions(rows);

    return `
<div class="detail-filter-bar">
  <label>
    <span>Search</span>
    <input type="text" id="detailTextFilter" placeholder="Employee, email, or role" oninput="filterEmployeeLoginTable()">
  </label>
  <label>
    <span>Role</span>
    <select id="detailRoleFilter" onchange="filterEmployeeLoginTable()">
      <option value="">All Roles</option>
      ${roleNames.map(roleName => `<option value="${escAttr(roleName)}">${esc(roleName)}</option>`).join('')}
    </select>
  </label>
  <label>
    <span>Status</span>
    <select id="detailStatusFilter" onchange="filterEmployeeLoginTable()">
      <option value="">All Statuses</option>
      <option value="success">Active</option>
      <option value="failed">Stale</option>
      <option value="unknown">Inactive</option>
    </select>
  </label>
  <label>
    <span>Login Age</span>
    <select id="detailAgeFilter" onchange="filterEmployeeLoginTable()">
      <option value="">Any Age</option>
      <option value="today">Today</option>
      <option value="last7">Last 7 Days</option>
      <option value="last30">Last 30 Days</option>
      <option value="last90">Last 90 Days</option>
      <option value="stale">Stale / No Login</option>
      <option value="never">Never Logged In</option>
    </select>
  </label>
  <div class="detail-filter-actions">
    <span id="employeeLoginVisibleCount">${esc(formatWholeNumber(rows.length))} of ${esc(formatWholeNumber(rows.length))} shown</span>
    <button type="button" class="btn btn-small" onclick="clearEmployeeLoginFilters()">Clear</button>
  </div>
</div>`;
  }

  function buildDetailRoleOptions(rows) {
    const roleMap = {};

    (rows || []).forEach(row => {
      roleMap[row.roleName || 'No successful login role'] = true;
    });

    return Object.keys(roleMap).sort((a, b) => a.localeCompare(b));
  }

  function buildTableRowHtml(row) {
    const status = getEmployeeStatus(row);
    const roleName = row.roleName || 'No successful login role';
    const lastLoginTime = row.lastLoginDate ? row.lastLoginDate.getTime() : 0;
    const daysSortValue = row.daysSinceLogin === null ? 999999 : row.daysSinceLogin;
    const weekendLogin = isWeekendDate(row.lastLoginDate);
    const weekendLoginLabel = getWeekendLoginLabel(row.lastLoginDate);
    const searchText = [
      row.name,
      row.email,
      roleName,
      row.lastLogin || 'Never logged in',
      status.text
    ].join(' ');

    return `
<tr class="${weekendLogin ? 'weekend-login-row' : ''}" data-weekend-login="${weekendLogin ? 'T' : 'F'}" data-detail-search="${escAttr(searchText)}" data-role="${escAttr(roleName)}" data-status="${escAttr(status.className)}" data-login-state="${row.lastLoginDate ? 'logged' : 'never'}" data-stale="${row.stale ? 'T' : 'F'}" data-days="${escAttr(row.daysSinceLogin === null ? '' : row.daysSinceLogin)}" data-sort-employee="${escAttr(row.name || '')}" data-sort-last-login="${escAttr(lastLoginTime)}" data-sort-role="${escAttr(roleName)}" data-sort-days="${escAttr(daysSortValue)}" data-sort-status="${escAttr(status.text)}">
  <td data-export-label="${escAttr(row.name || '')}">${buildEmployeeLink(row)}</td>
  <td>${esc(row.email)}</td>
  <td data-sort-value="${escAttr(lastLoginTime)}" data-export-label="${escAttr(row.lastLogin || 'Never logged in')}">${esc(row.lastLogin || 'Never logged in')}${weekendLogin ? `<span class="weekend-login-table-badge">${esc(weekendLoginLabel)}</span>` : ''}</td>
  <td>${esc(roleName)}</td>
  <td>${esc(row.loginAgeLabel)}</td>
  <td><span class="status-pill ${escAttr(status.className)}">${esc(status.text)}</span></td>
</tr>`;
  }

  function getEmployeeStatus(row) {
    if (row.inactive) {
      return {
        className: 'unknown',
        text: 'Inactive'
      };
    }

    if (row.stale) {
      return {
        className: 'failed',
        text: 'Stale'
      };
    }

    return {
      className: 'success',
      text: 'Active'
    };
  }

  function getDepartmentName(row) {
    return String(row && row.departmentName ? row.departmentName : 'No Department');
  }

  function buildEmployeeLink(row) {
    if (!row.name) return '';
    const developerBadge = isDashboardDeveloperEmployee(row) ? buildDeveloperAdminBadgeHtml(true) : '';
    if (!row.employeeUrl) return esc(row.name) + developerBadge;

    return `<a class="table-link" href="${escAttr(row.employeeUrl)}" target="_blank" rel="noopener">${esc(row.name)}</a>${developerBadge}`;
  }

  function buildEmployeeUrl(id) {
    if (!id) return '';

    try {
      return url.resolveRecord({
        recordType: 'employee',
        recordId: id,
        isEditMode: false
      }) || '';
    } catch (e) {
      return '';
    }
  }

  function buildScript() {
    return `
<script>
  var employeeLoginSortState = { key: 'lastLogin', direction: 'desc' };
  var autoRefreshTimer = null;
  var autoRefreshCountdownTimer = null;
  var autoRefreshRemainingSeconds = 0;
  var autoRefreshEnabledStorageKey = 'psiqEmployeeLastLoginAutoRefreshEnabled';
  var autoRefreshSecondsStorageKey = 'psiqEmployeeLastLoginAutoRefreshSeconds';
  var todayLoginSnapshotStorageKey = 'psiqEmployeeLastLoginTodaySnapshot';

  function refreshLoginReport(){
    if(document.forms && document.forms[0]){
      document.forms[0].submit();
      return;
    }

    window.location.reload();
  }

  function initAutoRefreshControls(){
    var enabledInput = document.getElementById('autoRefreshEnabled');
    var frequencySelect = document.getElementById('autoRefreshFrequency');
    if(!enabledInput || !frequencySelect) return;

    var savedEnabled = getStoredValue(autoRefreshEnabledStorageKey);
    var savedSeconds = getStoredValue(autoRefreshSecondsStorageKey);
    var seconds = normalizeAutoRefreshSeconds(savedSeconds || frequencySelect.value || 300);

    enabledInput.checked = savedEnabled === 'T';
    frequencySelect.value = String(seconds);

    scheduleAutoRefresh(enabledInput.checked, seconds);
  }

  function updateAutoRefreshSettings(){
    var enabledInput = document.getElementById('autoRefreshEnabled');
    var frequencySelect = document.getElementById('autoRefreshFrequency');
    if(!enabledInput || !frequencySelect) return;

    var seconds = normalizeAutoRefreshSeconds(frequencySelect.value);
    frequencySelect.value = String(seconds);

    setStoredValue(autoRefreshEnabledStorageKey, enabledInput.checked ? 'T' : 'F');
    setStoredValue(autoRefreshSecondsStorageKey, String(seconds));
    scheduleAutoRefresh(enabledInput.checked, seconds);
  }

  function scheduleAutoRefresh(enabled, seconds){
    clearAutoRefreshTimers();

    if(!enabled){
      setAutoRefreshStatus('');
      return;
    }

    autoRefreshRemainingSeconds = normalizeAutoRefreshSeconds(seconds);
    updateAutoRefreshCountdown();

    autoRefreshCountdownTimer = window.setInterval(function(){
      autoRefreshRemainingSeconds -= 1;
      updateAutoRefreshCountdown();
    }, 1000);

    autoRefreshTimer = window.setTimeout(function(){
      refreshLoginReport();
    }, autoRefreshRemainingSeconds * 1000);
  }

  function clearAutoRefreshTimers(){
    if(autoRefreshTimer){
      window.clearTimeout(autoRefreshTimer);
      autoRefreshTimer = null;
    }

    if(autoRefreshCountdownTimer){
      window.clearInterval(autoRefreshCountdownTimer);
      autoRefreshCountdownTimer = null;
    }
  }

  function updateAutoRefreshCountdown(){
    if(autoRefreshRemainingSeconds <= 0){
      setAutoRefreshStatus('Refreshing...');
      return;
    }

    setAutoRefreshStatus('Next ' + formatAutoRefreshDuration(autoRefreshRemainingSeconds));
  }

  function setAutoRefreshStatus(text){
    var status = document.getElementById('autoRefreshStatus');
    if(status) status.textContent = text || '';
  }

  function normalizeAutoRefreshSeconds(value){
    var seconds = Number(value || 300);
    var allowed = [60, 300, 900, 1800];

    return allowed.indexOf(seconds) >= 0 ? seconds : 300;
  }

  function formatAutoRefreshDuration(seconds){
    var safeSeconds = Math.max(0, Number(seconds || 0));
    var minutes = Math.floor(safeSeconds / 60);
    var remainder = safeSeconds % 60;

    return minutes + ':' + String(remainder).padStart(2, '0');
  }

  function getStoredValue(key){
    try {
      return window.localStorage ? window.localStorage.getItem(key) : '';
    } catch (e) {
      return '';
    }
  }

  function setStoredValue(key, value){
    try {
      if(window.localStorage) window.localStorage.setItem(key, value);
    } catch (e) {
      // Ignore storage restrictions; auto refresh still works for this page load.
    }
  }

  function initializeEmployeeLoginDashboard(){
    highlightNewTodayLoginMembers();
    initAutoRefreshControls();
    initEmployeeLoginPopupEvents();
  }

  function highlightNewTodayLoginMembers(){
    var detail = document.getElementById('todayRoleDetail');
    if(!detail) return;

    var snapshotKey = detail.getAttribute('data-snapshot-key') || '';
    var employees = Array.prototype.slice.call(detail.querySelectorAll('.today-role-employee-list .employee-export-row'));
    var currentKeys = [];
    var previousSnapshot = readTodayLoginSnapshot();
    var previousKeys = {};
    var canHighlight = previousSnapshot && previousSnapshot.snapshotKey === snapshotKey;

    if(canHighlight){
      (previousSnapshot.employeeKeys || []).forEach(function(key){
        previousKeys[key] = true;
      });
    }

    employees.forEach(function(employee){
      var key = buildTodayLoginEmployeeKey(employee);
      if(!key) return;

      currentKeys.push(key);

      if(canHighlight && !previousKeys[key]){
        employee.classList.add('new-login-member');
        employee.setAttribute('data-new-login-member', 'T');
        employee.setAttribute('title', 'New since the previous refresh');
      }
    });

    writeTodayLoginSnapshot(snapshotKey, currentKeys);
  }

  function readTodayLoginSnapshot(){
    var storedValue = getStoredValue(todayLoginSnapshotStorageKey);
    if(!storedValue) return null;

    try {
      return JSON.parse(storedValue);
    } catch (e) {
      return null;
    }
  }

  function writeTodayLoginSnapshot(snapshotKey, employeeKeys){
    var uniqueKeys = {};
    var snapshot = {
      snapshotKey: snapshotKey || '',
      employeeKeys: []
    };

    (employeeKeys || []).forEach(function(key){
      if(!key || uniqueKeys[key]) return;

      uniqueKeys[key] = true;
      snapshot.employeeKeys.push(key);
    });

    setStoredValue(todayLoginSnapshotStorageKey, JSON.stringify(snapshot));
  }

  function buildTodayLoginEmployeeKey(employee){
    var panel = employee.closest ? employee.closest('.today-role-employee-list') : null;
    var role = panel ? (panel.getAttribute('data-export-role') || '') : '';
    var employeeId = employee.getAttribute('data-employee-id') ||
      employee.getAttribute('data-employee-email') ||
      employee.getAttribute('data-employee-name') ||
      '';

    return role + '|' + employeeId;
  }

  function exportEmployeeLoginCsv(){
    exportTableCsv('employeeLoginTable', 'employee_last_login.csv');
  }

  function exportTableCsv(tableId, filename){
    var table = document.getElementById(tableId);
    if(!table) return;

    var rows = Array.prototype.slice.call(table.querySelectorAll('tr')).filter(function(row){
      return !row.parentElement || row.parentElement.tagName === 'THEAD' || row.style.display !== 'none';
    });
    if(!rows.length) return;

    var csv = rows.map(function(row){
      return Array.prototype.slice.call(row.children).map(function(cell){
        return escapeCsvCell(cell.getAttribute('data-export-label') || cell.textContent || '');
      }).join(',');
    }).join('\\n');

    downloadCsv(csv, sanitizeCsvFilename(filename || tableId));
  }

  function exportEmployeePanelCsv(panelId){
    var panel = document.getElementById(panelId);
    if(!panel) return;

    var rows = Array.prototype.slice.call(panel.querySelectorAll('.employee-export-row'));
    if(!rows.length) return;

    var period = panel.getAttribute('data-export-period') || '';
    var role = panel.getAttribute('data-export-role') || '';
    var csvRows = [['Period', 'Role', 'Employee', 'Email', 'Department', 'Last Login Date / Time', 'Weekend Login', 'Employee URL']];

    rows.forEach(function(row){
      csvRows.push([
        period,
        role,
        row.getAttribute('data-employee-name') || '',
        row.getAttribute('data-employee-email') || '',
        row.getAttribute('data-employee-department') || '',
        row.getAttribute('data-employee-last-login') || '',
        row.getAttribute('data-weekend-login-label') || (row.getAttribute('data-weekend-login') === 'T' ? 'Weekend' : ''),
        row.getAttribute('data-employee-url') || ''
      ]);
    });

    var csv = csvRows.map(function(row){
      return row.map(escapeCsvCell).join(',');
    }).join('\\n');
    var title = panel.getAttribute('data-export-title') || 'employee_logins';

    downloadCsv(csv, sanitizeCsvFilename(title));
  }

  function escapeCsvCell(value){
    return '"' + String(value == null ? '' : value).replace(/"/g, '""').replace(/\\s+/g, ' ').trim() + '"';
  }

  function sanitizeCsvFilename(value){
    var filename = String(value || 'employee_logins').toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '');

    if(!filename) filename = 'employee_logins';
    if(filename.substring(filename.length - 4) !== '.csv') filename += '.csv';

    return filename;
  }

  function downloadCsv(csv, filename){
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename || 'employee_logins.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }

  function showKpiDetail(kpiId){
    var detail = document.getElementById('kpiDetailPanel');
    if(!detail) return;

    var empty = document.getElementById('kpiDetailEmpty');
    var panels = detail.querySelectorAll('.kpi-panel-section');
    var cards = document.querySelectorAll('.kpi-card');
    var targetId = 'kpiPanel_' + kpiId;
    var foundPanel = false;

    for(var i = 0; i < panels.length; i++){
      if(panels[i].id === targetId){
        panels[i].style.display = 'block';
        foundPanel = true;
      } else {
        panels[i].style.display = 'none';
      }
    }

    for(var j = 0; j < cards.length; j++){
      if(cards[j].getAttribute('data-kpi-id') === kpiId){
        cards[j].classList.add('active');
      } else {
        cards[j].classList.remove('active');
      }
    }

    if(empty) empty.style.display = foundPanel ? 'none' : 'block';
    if(foundPanel && detail.scrollIntoView) detail.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function showDepartmentEmployees(departmentIndex){
    var detail = document.getElementById('departmentEmployeeDetail');
    if(!detail) return;

    var empty = document.getElementById('departmentEmployeeDetailEmpty');
    var panels = detail.querySelectorAll('.department-employee-panel');
    var rows = document.querySelectorAll('#departmentDistributionTable tbody tr');
    var targetId = 'departmentEmployees' + departmentIndex;
    var foundPanel = false;

    for(var i = 0; i < panels.length; i++){
      if(panels[i].id === targetId){
        panels[i].style.display = 'block';
        foundPanel = true;
      } else {
        panels[i].style.display = 'none';
      }
    }

    for(var j = 0; j < rows.length; j++){
      if(Number(rows[j].getAttribute('data-department-index')) === Number(departmentIndex)){
        rows[j].classList.add('active');
      } else {
        rows[j].classList.remove('active');
      }
    }

    if(empty) empty.style.display = foundPanel ? 'none' : 'block';
    if(foundPanel && detail.scrollIntoView) detail.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function sortEmployeeLoginTable(sortKey){
    var table = document.getElementById('employeeLoginTable');
    if(!table || !table.tBodies || !table.tBodies.length) return;

    var tbody = table.tBodies[0];
    var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
    var direction = getNextEmployeeLoginSortDirection(sortKey);

    rows.sort(function(a, b){
      return compareEmployeeLoginRows(a, b, sortKey, direction);
    });

    rows.forEach(function(row){
      tbody.appendChild(row);
    });

    employeeLoginSortState = {
      key: sortKey,
      direction: direction
    };

    updateEmployeeLoginSortIndicators(sortKey, direction);
  }

  function getNextEmployeeLoginSortDirection(sortKey){
    if(employeeLoginSortState && employeeLoginSortState.key === sortKey){
      return employeeLoginSortState.direction === 'asc' ? 'desc' : 'asc';
    }

    return sortKey === 'lastLogin' || sortKey === 'days' ? 'desc' : 'asc';
  }

  function compareEmployeeLoginRows(a, b, sortKey, direction){
    var aValue = getEmployeeLoginSortValue(a, sortKey);
    var bValue = getEmployeeLoginSortValue(b, sortKey);
    var result = 0;

    if(typeof aValue === 'number' && typeof bValue === 'number'){
      result = aValue - bValue;
    } else {
      result = String(aValue || '').localeCompare(String(bValue || ''));
    }

    if(result !== 0){
      return direction === 'desc' ? -result : result;
    }

    return String(a.getAttribute('data-sort-employee') || '')
      .localeCompare(String(b.getAttribute('data-sort-employee') || ''));
  }

  function getEmployeeLoginSortValue(row, sortKey){
    if(sortKey === 'lastLogin') return Number(row.getAttribute('data-sort-last-login') || 0);
    if(sortKey === 'days') return Number(row.getAttribute('data-sort-days') || 999999);
    if(sortKey === 'role') return String(row.getAttribute('data-sort-role') || '').toLowerCase();
    if(sortKey === 'status') return String(row.getAttribute('data-sort-status') || '').toLowerCase();

    return String(row.getAttribute('data-sort-employee') || '').toLowerCase();
  }

  function updateEmployeeLoginSortIndicators(sortKey, direction){
    var table = document.getElementById('employeeLoginTable');
    if(!table) return;

    var headers = table.querySelectorAll('th[data-sort-key]');

    for(var i = 0; i < headers.length; i++){
      var header = headers[i];
      var isActive = header.getAttribute('data-sort-key') === sortKey;
      var button = header.querySelector('.sort-header');
      var indicator = header.querySelector('.sort-indicator');

      header.setAttribute('aria-sort', isActive ? (direction === 'asc' ? 'ascending' : 'descending') : 'none');

      if(button){
        if(isActive) button.classList.add('active');
        else button.classList.remove('active');
      }

      if(indicator){
        indicator.className = 'sort-indicator' + (isActive ? ' ' + direction : '');
      }
    }
  }

  function filterEmployeeLoginTable(){
    var table = document.getElementById('employeeLoginTable');
    if(!table || !table.tBodies || !table.tBodies.length) return;

    var textFilter = (document.getElementById('detailTextFilter') || {}).value || '';
    var roleFilter = (document.getElementById('detailRoleFilter') || {}).value || '';
    var statusFilter = (document.getElementById('detailStatusFilter') || {}).value || '';
    var ageFilter = (document.getElementById('detailAgeFilter') || {}).value || '';
    var rows = Array.prototype.slice.call(table.tBodies[0].querySelectorAll('tr'));
    var searchText = String(textFilter).toLowerCase();
    var visibleCount = 0;

    rows.forEach(function(row){
      var rowSearch = String(row.getAttribute('data-detail-search') || '').toLowerCase();
      var role = row.getAttribute('data-role') || '';
      var status = row.getAttribute('data-status') || '';
      var loginState = row.getAttribute('data-login-state') || '';
      var stale = row.getAttribute('data-stale') === 'T';
      var daysText = row.getAttribute('data-days');
      var days = daysText === '' || daysText == null ? null : Number(daysText);
      var visible = true;

      if(searchText && rowSearch.indexOf(searchText) < 0) visible = false;
      if(roleFilter && role !== roleFilter) visible = false;
      if(statusFilter && status !== statusFilter) visible = false;
      if(ageFilter && !matchesEmployeeLoginAgeFilter(ageFilter, days, stale, loginState)) visible = false;

      row.style.display = visible ? '' : 'none';
      if(visible) visibleCount += 1;
    });

    updateEmployeeLoginVisibleCount(visibleCount, rows.length);
  }

  function matchesEmployeeLoginAgeFilter(ageFilter, days, stale, loginState){
    if(ageFilter === 'today') return days === 0;
    if(ageFilter === 'last7') return days !== null && days <= 7;
    if(ageFilter === 'last30') return days !== null && days <= 30;
    if(ageFilter === 'last90') return days !== null && days <= 90;
    if(ageFilter === 'stale') return !!stale || loginState === 'never';
    if(ageFilter === 'never') return loginState === 'never';
    return true;
  }

  function updateEmployeeLoginVisibleCount(visibleCount, totalCount){
    var count = document.getElementById('employeeLoginVisibleCount');
    if(!count) return;

    count.textContent = formatClientWholeNumber(visibleCount) + ' of ' + formatClientWholeNumber(totalCount) + ' shown';
  }

  function clearEmployeeLoginFilters(){
    var textFilter = document.getElementById('detailTextFilter');
    var roleFilter = document.getElementById('detailRoleFilter');
    var statusFilter = document.getElementById('detailStatusFilter');
    var ageFilter = document.getElementById('detailAgeFilter');

    if(textFilter) textFilter.value = '';
    if(roleFilter) roleFilter.value = '';
    if(statusFilter) statusFilter.value = '';
    if(ageFilter) ageFilter.value = '';

    filterEmployeeLoginTable();
  }

  function formatClientWholeNumber(value){
    return String(Number(value || 0)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
  }

  function showTodayRoleEmployees(roleIndex){
    var detail = document.getElementById('todayRoleDetail');
    if(!detail) return;

    var empty = document.getElementById('todayRoleDetailEmpty');
    var panels = detail.querySelectorAll('.today-role-employee-list');
    var rows = document.querySelectorAll('.today-role-row');

    for(var i = 0; i < panels.length; i++){
      panels[i].style.display = i === roleIndex ? 'block' : 'none';
    }

    for(var j = 0; j < rows.length; j++){
      if(Number(rows[j].getAttribute('data-role-index')) === roleIndex){
        rows[j].classList.add('active');
      } else {
        rows[j].classList.remove('active');
      }
    }

    if(empty) empty.style.display = 'none';
    if(detail.scrollIntoView) detail.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function showMonthlyRoleEmployees(roleIndex, monthIndex){
    showMonthlyEmployeePanel('monthlyRoleEmployees' + roleIndex + '_' + monthIndex, 'chart', roleIndex, monthIndex);
  }

  function showMonthlyMatrixEmployees(roleIndex, monthIndex){
    showMonthlyEmployeePanel('monthlyMatrixEmployees' + roleIndex + '_' + monthIndex, 'matrix', roleIndex, monthIndex);
  }

  function showMonthlyEmployeePanel(targetId, source, roleIndex, monthIndex){
    var detail = document.getElementById('monthlyRoleDetail');
    if(!detail) return;

    var empty = document.getElementById('monthlyRoleDetailEmpty');
    var panels = detail.querySelectorAll('.monthly-role-employee-list');
    var segments = document.querySelectorAll('.monthly-role-segment');
    var monthHighlights = document.querySelectorAll('.monthly-role-month-highlight');
    var matrixCounts = document.querySelectorAll('.role-matrix-count');
    var foundPanel = false;

    for(var i = 0; i < panels.length; i++){
      if(panels[i].id === targetId){
        panels[i].style.display = 'block';
        foundPanel = true;
      } else {
        panels[i].style.display = 'none';
      }
    }

    for(var j = 0; j < segments.length; j++){
      if(source === 'chart' &&
          Number(segments[j].getAttribute('data-role-index')) === roleIndex &&
          Number(segments[j].getAttribute('data-month-index')) === monthIndex){
        segments[j].classList.add('active');
      } else {
        segments[j].classList.remove('active');
      }
    }

    for(var k = 0; k < matrixCounts.length; k++){
      if(source === 'matrix' &&
          Number(matrixCounts[k].getAttribute('data-role-index')) === roleIndex &&
          Number(matrixCounts[k].getAttribute('data-month-index')) === monthIndex){
        matrixCounts[k].classList.add('active');
      } else {
        matrixCounts[k].classList.remove('active');
      }
    }

    for(var m = 0; m < monthHighlights.length; m++){
      if(foundPanel && Number(monthHighlights[m].getAttribute('data-month-index')) === monthIndex){
        monthHighlights[m].classList.add('active');
      } else {
        monthHighlights[m].classList.remove('active');
      }
    }

    if(empty) empty.style.display = foundPanel ? 'none' : 'block';
    if(foundPanel && detail.scrollIntoView) detail.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function openEmployeeLoginPopup(employee){
    var popup = document.getElementById('employeeLoginPopup');
    if(!popup || !employee) return;

    var panel = employee.closest ? employee.closest('.today-role-employee-list,.monthly-role-employee-list') : null;
    var name = employee.getAttribute('data-employee-name') || 'Employee Login Detail';
    var email = employee.getAttribute('data-employee-email') || '';
    var department = employee.getAttribute('data-employee-department') || 'No Department';
    var lastLogin = employee.getAttribute('data-employee-last-login') || 'Not available';
    var weekendLogin = employee.getAttribute('data-weekend-login') === 'T';
    var weekendLoginLabel = employee.getAttribute('data-weekend-login-label') || 'Weekend';
    var dashboardDeveloper = employee.getAttribute('data-dashboard-developer') === 'T';
    var employeeUrl = employee.getAttribute('data-employee-url') || '';
    var role = panel ? (panel.getAttribute('data-export-role') || '') : '';
    var period = panel ? (panel.getAttribute('data-export-period') || '') : '';
    var recordLink = document.getElementById('employeePopupRecordLink');
    var developerBadge = document.getElementById('employeePopupDeveloperBadge');

    setPopupText('employeePopupName', name);
    setPopupText('employeePopupEmail', email);
    setPopupText('employeePopupDepartment', department);
    setPopupText('employeePopupLastLogin', lastLogin);
    setPopupText('employeePopupWeekendLogin', weekendLogin ? weekendLoginLabel : 'No');
    setPopupText('employeePopupRole', role || 'Not available');
    setPopupText('employeePopupPeriod', period || 'Not available');

    if(developerBadge){
      developerBadge.style.display = dashboardDeveloper ? 'inline-flex' : 'none';
    }

    if(dashboardDeveloper){
      popup.classList.add('dashboard-developer-popup');
    } else {
      popup.classList.remove('dashboard-developer-popup');
    }

    if(recordLink){
      if(employeeUrl){
        recordLink.href = employeeUrl;
        recordLink.style.display = 'inline-block';
      } else {
        recordLink.href = '#';
        recordLink.style.display = 'none';
      }
    }

    popup.style.display = 'flex';
    popup.setAttribute('aria-hidden', 'false');

    var closeButton = popup.querySelector('.employee-popup-close');
    if(closeButton && closeButton.focus) closeButton.focus();
  }

  function closeEmployeeLoginPopup(){
    var popup = document.getElementById('employeeLoginPopup');
    if(!popup) return;

    popup.style.display = 'none';
    popup.setAttribute('aria-hidden', 'true');
  }

  function setPopupText(id, text){
    var node = document.getElementById(id);
    if(node) node.textContent = text || '';
  }

  function initEmployeeLoginPopupEvents(){
    var popup = document.getElementById('employeeLoginPopup');
    if(popup && !popup.getAttribute('data-popup-events-ready')){
      popup.setAttribute('data-popup-events-ready', 'T');
      popup.addEventListener('click', function(e){
        if(e.target === popup) closeEmployeeLoginPopup();
      });
    }

    if(!document.body.getAttribute('data-employee-popup-keydown-ready')){
      document.body.setAttribute('data-employee-popup-keydown-ready', 'T');
      document.addEventListener('keydown', function(e){
        if(e.key === 'Escape') closeEmployeeLoginPopup();
      });
    }
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', initializeEmployeeLoginDashboard);
  } else {
    initializeEmployeeLoginDashboard();
  }
</script>`;
  }

  function getPageSize() {
    const configured = Number(CONFIG.pageSize || 1000);
    return Math.max(5, Math.min(1000, configured));
  }

  function isSuccessfulLoginStatus(status) {
    return String(status || '').toLowerCase().indexOf('success') >= 0;
  }

  function isTrueValue(value) {
    if (value === true) return true;
    return String(value || '').toUpperCase() === 'T' || String(value || '').toUpperCase() === 'TRUE';
  }

  function isWeekendLoginValue(value) {
    return isWeekendDate(parseNsDateTime(value));
  }

  function isWeekendDate(dateObj) {
    if (!dateObj || isNaN(dateObj.getTime())) return false;

    const day = dateObj.getDay();
    return day === 0 || day === 6;
  }

  function getWeekendLoginLabel(value) {
    const dateObj = parseNsDateTime(value);
    if (!isWeekendDate(dateObj)) return '';

    return dateObj.getDay() === 0 ? 'Sunday' : 'Saturday';
  }

  function parseNsDateTime(value) {
    if (!value) return null;

    if (Object.prototype.toString.call(value) === '[object Date]') {
      return isNaN(value.getTime()) ? null : value;
    }

    try {
      const parsedDateTime = format.parse({
        value: String(value),
        type: format.Type.DATETIME
      });

      if (parsedDateTime && !isNaN(parsedDateTime.getTime())) {
        return parsedDateTime;
      }
    } catch (e) {
      // Try date-only and native parsing below.
    }

    try {
      const parsedDate = format.parse({
        value: String(value),
        type: format.Type.DATE
      });

      if (parsedDate && !isNaN(parsedDate.getTime())) {
        return parsedDate;
      }
    } catch (e) {
      // Fall through to native Date parsing.
    }

    const nativeDate = new Date(value);
    return isNaN(nativeDate.getTime()) ? null : nativeDate;
  }

  function formatSearchDate(dateObj) {
    try {
      return format.format({
        value: dateObj,
        type: format.Type.DATE
      });
    } catch (e) {
      return [
        dateObj.getMonth() + 1,
        dateObj.getDate(),
        dateObj.getFullYear()
      ].join('/');
    }
  }

  function stripTime(dateObj) {
    return new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());
  }

  function formatLastRefreshedText(value) {
    const refreshedAt = value ? new Date(value) : new Date();

    if (!refreshedAt || isNaN(refreshedAt.getTime())) {
      return 'Unknown';
    }

    let hours = refreshedAt.getHours();
    const suffix = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;

    return [
      refreshedAt.getMonth() + 1,
      refreshedAt.getDate(),
      refreshedAt.getFullYear()
    ].join('/') + ' ' + hours + ':' + String(refreshedAt.getMinutes()).padStart(2, '0') + ' ' + suffix;
  }

  function formatWholeNumber(value) {
    return String(Number(value || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function formatOneDecimal(value) {
    const rounded = Math.round(Number(value || 0) * 10) / 10;
    return String(rounded).replace(/\.0$/, '');
  }

  function roundSvgNumber(value) {
    return Math.round(Number(value || 0) * 100) / 100;
  }

  function truncateText(value, maxLen) {
    const text = String(value || '');
    return text.length > maxLen ? text.substring(0, maxLen - 3) + '...' : text;
  }

  function buildCss() {
    return `
<style>
.dash{font-family:Arial,sans-serif;background:linear-gradient(180deg,#f8fafc 0%,#eef3f8 100%);color:#1f2937;padding:16px}
.dash-topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px}
.dash h1{font-size:24px;line-height:1.2;margin:0;color:#111827;font-weight:800}
.dash-sub{color:#64748b;margin-top:4px;font-size:13px}
.dash-actions{display:flex;gap:8px;align-items:center}
.auto-refresh-toggle{display:flex;align-items:center;gap:6px;border:1px solid #d1d5db;background:#fff;border-radius:4px;padding:7px 9px;color:#334155;font-size:12px;font-weight:800;white-space:nowrap}
.auto-refresh-toggle input{width:14px;height:14px;margin:0}
.auto-refresh-frequency{border:1px solid #d1d5db;background:#fff;color:#111827;border-radius:4px;padding:8px 9px;font-size:12px;font-weight:800;min-height:36px}
.auto-refresh-status{color:#64748b;font-size:12px;font-weight:800;white-space:nowrap;min-width:72px}
.btn{display:inline-block;border:1px solid #d1d5db;background:#fff;color:#111827;border-radius:4px;padding:9px 13px;font-weight:700;cursor:pointer;text-decoration:none}
.btn-small{padding:6px 9px;font-size:11px;line-height:1.2;white-space:nowrap}
.btn-primary{background:linear-gradient(135deg,#2563eb,#0ea5e9);border-color:#2563eb;color:#fff}
.warning-banner{border:1px solid #fde68a;background:#fffbeb;color:#92400e;border-radius:6px;padding:10px 12px;margin-bottom:12px;font-weight:800}
.error-banner{border:1px solid #fecaca;background:#fff1f2;color:#991b1b;border-radius:6px;padding:10px 12px;margin-bottom:12px;font-weight:700}
.source-help{background:#fff;border:1px solid #dbeafe;border-left:4px solid #2563eb;border-radius:4px;padding:14px;margin-bottom:14px;box-shadow:0 1px 4px rgba(15,23,42,.08)}
.kpi-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:14px}
.kpi-card{appearance:none;width:100%;text-align:left;font-family:inherit;background:linear-gradient(135deg,#ffffff 0%,#f8fafc 48%,#eef2ff 100%);border:1px solid #e5e7eb;border-left:4px solid #64748b;border-radius:4px;padding:14px;box-shadow:0 1px 4px rgba(15,23,42,.08);min-height:78px;cursor:pointer}
.kpi-card.good{border-left-color:#0f9f8e;background:linear-gradient(135deg,#ffffff 0%,#ecfeff 58%,#ccfbf1 100%)}
.kpi-card.bad{border-left-color:#f97316;background:linear-gradient(135deg,#ffffff 0%,#fff7ed 58%,#fed7aa 100%)}
.kpi-card.neutral{border-left-color:#94a3b8}
.kpi-card.wide{border-left-color:#2563eb;background:linear-gradient(135deg,#ffffff 0%,#eff6ff 58%,#dbeafe 100%)}
.kpi-card.dept{border-left-color:#16a34a;background:linear-gradient(135deg,#ffffff 0%,#f0fdf4 58%,#dcfce7 100%)}
.kpi-card:hover,.kpi-card.active{transform:translateY(-1px);box-shadow:0 5px 14px rgba(15,23,42,.14);border-color:#bfdbfe}
.kpi-card:focus{outline:2px solid #2563eb;outline-offset:2px}
.kpi-label{font-size:11px;text-transform:uppercase;color:#64748b;font-weight:800;letter-spacing:.04em}
.kpi-value{font-size:28px;color:#111827;font-weight:800;margin-top:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kpi-detail{font-size:12px;color:#64748b;font-weight:800;margin-top:6px}
.kpi-detail-panel{border:1px solid #dbeafe;background:#fff;border-radius:4px;margin:-4px 0 14px 0;padding:12px;box-shadow:0 1px 4px rgba(15,23,42,.08)}
.kpi-detail-empty{color:#64748b;font-weight:800;text-align:center;padding:14px}
.kpi-table-scroll{overflow:auto;max-height:360px;border:1px solid #e5e7eb;border-radius:4px;background:#fff}
.kpi-employee-table,.kpi-role-summary-table,.kpi-department-summary-table{width:100%;border-collapse:collapse;font-size:12px}
.kpi-employee-table th,.kpi-role-summary-table th,.kpi-department-summary-table th{position:sticky;top:0;background:#f8fafc;color:#334155;border-bottom:1px solid #cbd5e1;padding:8px 9px;text-align:left;white-space:nowrap;font-weight:800}
.kpi-employee-table td,.kpi-role-summary-table td,.kpi-department-summary-table td{border-bottom:1px solid #e5e7eb;padding:8px 9px;color:#1f2937;vertical-align:top}
.kpi-employee-table tbody tr:nth-child(even) td,.kpi-role-summary-table tbody tr:nth-child(even) td,.kpi-department-summary-table tbody tr:nth-child(even) td{background:#fbfdff}
.kpi-role-summary-table th:not(:first-child),.kpi-role-summary-table td:not(:first-child),.kpi-department-summary-table th:not(:first-child),.kpi-department-summary-table td:not(:first-child){text-align:right}
.department-distribution-panel{margin-bottom:14px;background:linear-gradient(135deg,#ffffff 0%,#f8fcff 50%,#f0fdf4 100%)}
.department-distribution-body{display:grid;grid-template-columns:minmax(240px,340px) minmax(0,1fr);gap:16px;align-items:center}
.department-donut-wrap{display:flex;align-items:center;justify-content:center;min-height:300px;border:1px solid #dbeafe;background:linear-gradient(135deg,#ffffff 0%,#eff6ff 52%,#ecfdf5 100%);border-radius:4px;padding:10px;box-shadow:inset 0 1px 8px rgba(37,99,235,.06)}
.department-donut-svg{display:block;width:100%;max-width:320px;height:auto;overflow:visible}
.department-donut-bg{fill:none}
.department-donut-segment{filter:drop-shadow(0 3px 4px rgba(15,23,42,.12));transition:filter .16s ease,stroke-width .16s ease}
.department-donut-segment:hover{filter:drop-shadow(0 7px 10px rgba(15,23,42,.22));stroke-width:38px}
.department-donut-hole{fill:#fff;filter:drop-shadow(0 4px 12px rgba(15,23,42,.12))}
.department-donut-total{font-size:22px;fill:#111827;font-weight:900}
.department-donut-caption{font-size:10px;fill:#64748b;font-weight:900;text-transform:uppercase}
.department-donut-label{font-size:11px;fill:#111827;font-weight:900;paint-order:stroke;stroke:#fff;stroke-width:4px;stroke-linejoin:round}
.department-ranking-table-wrap{overflow:auto;max-height:318px;border:1px solid #e5e7eb;border-radius:4px;background:#fff}
.department-ranking-table{width:100%;border-collapse:collapse;font-size:12px}
.department-ranking-table th{position:sticky;top:0;background:#f8fafc;color:#334155;border-bottom:1px solid #cbd5e1;padding:8px 9px;text-align:left;white-space:nowrap;font-weight:800}
.department-ranking-table td{border-bottom:1px solid #e5e7eb;padding:8px 9px;color:#1f2937;vertical-align:middle}
.department-ranking-table tbody tr:nth-child(even) td{background:#fbfdff}
.department-ranking-table tbody tr.active td{background:#eff6ff!important;box-shadow:inset 0 1px 0 rgba(37,99,235,.08),inset 0 -1px 0 rgba(37,99,235,.08)}
.department-ranking-table tbody tr.active td:first-child{box-shadow:inset 4px 0 0 #2563eb,inset 0 1px 0 rgba(37,99,235,.08),inset 0 -1px 0 rgba(37,99,235,.08)}
.department-ranking-table th:not(:first-child):not(:nth-child(2)),.department-ranking-table td:not(:first-child):not(:nth-child(2)){text-align:right}
.department-rank-chip{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;color:#fff;font-size:11px;font-weight:900;box-shadow:0 0 0 2px rgba(255,255,255,.9),0 1px 4px rgba(15,23,42,.16)}
.department-rank-name{display:inline-grid;grid-template-columns:10px minmax(0,1fr);align-items:center;gap:8px;min-width:180px;max-width:360px;font-weight:800}
.department-rank-dot{width:10px;height:10px;border-radius:50%;box-shadow:0 0 0 2px rgba(255,255,255,.9)}
.department-drilldown-button,.department-count-button{appearance:none;border:0;background:transparent;color:#111827;font:inherit;font-weight:900;cursor:pointer}
.department-drilldown-button{display:inline-grid;grid-template-columns:10px minmax(0,1fr);align-items:center;gap:8px;min-width:180px;max-width:360px;text-align:left}
.department-count-button{padding:2px 6px;border-radius:4px}
.department-drilldown-button:hover,.department-count-button:hover{color:#1d4ed8;background:#eff6ff}
.department-drilldown-button:focus,.department-count-button:focus{outline:2px solid #2563eb;outline-offset:1px}
.department-employee-detail{border:1px solid #dbeafe;background:#fff;border-radius:4px;margin-top:12px;padding:12px}
.department-employee-detail-empty{color:#64748b;font-weight:800;text-align:center;padding:14px}
.panel{background:#fff;border:1px solid #e5e7eb;border-radius:4px;box-shadow:0 1px 4px rgba(15,23,42,.08);padding:14px}
.panel-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px}
.panel h2{font-size:14px;margin:0;color:#111827;font-weight:800}
.panel-head span{display:block;font-size:12px;color:#64748b;margin-top:2px}
.today-role-panel{margin-bottom:14px;background:linear-gradient(135deg,#ffffff 0%,#f8fcff 52%,#fff7ed 100%)}
.today-role-chart-wrap{max-height:620px;overflow:auto;padding-right:2px}
.today-role-chart-wrap svg{display:block;width:100%;height:auto;min-height:320px;filter:drop-shadow(0 6px 14px rgba(14,165,233,.08))}
.today-role-bg{fill:url(#todayRoleBackground);stroke:#dbeafe;stroke-width:1}
.today-role-wave{fill:url(#todayRoleWave)}
.today-role-grid{stroke:#dbe8f2;stroke-width:1}
.today-role-axis{font-size:12px;fill:#7b8798;font-weight:800}
.today-role-row{cursor:pointer;outline:none}
.today-role-row:hover .today-role-row-label,.today-role-row.active .today-role-row-label{fill:#111827}
.today-role-row:hover .today-role-bar,.today-role-row.active .today-role-bar{filter:drop-shadow(0 5px 10px rgba(15,23,42,.26))}
.today-role-bar{filter:drop-shadow(0 4px 7px rgba(15,23,42,.18))}
.today-role-row-label{font-size:12px;fill:#334155;font-weight:800}
.today-role-count{font-size:12px;fill:#111827;font-weight:900}
.today-role-count.inside{fill:#ffffff}
.today-role-legend-dot{fill:#20c997}
.today-role-legend{font-size:12px;fill:#334155;font-weight:800}
.today-role-detail{border:1px solid #dbeafe;background:#fff;border-radius:4px;margin-top:10px;padding:12px}
.today-role-detail-empty{color:#64748b;font-weight:800;text-align:center;padding:14px}
.today-role-detail-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
.today-role-detail-head b{display:block;color:#111827;font-size:13px}
.today-role-detail-head span{display:block;color:#64748b;font-size:12px;font-weight:800;margin-top:2px}
.today-role-employee-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px}
.today-role-employee{appearance:none;position:relative;display:block;width:100%;text-align:left;font:inherit;border:1px solid #e5e7eb;background:#fbfdff;border-radius:4px;padding:8px 9px;min-width:0;cursor:pointer}
.today-role-employee:hover{border-color:#bfdbfe;background:#f8fcff}
.today-role-employee:focus{outline:2px solid #2563eb;outline-offset:1px}
.developer-admin-badge{display:inline-flex;align-items:center;gap:6px;vertical-align:middle;border:1px solid #93c5fd;background:linear-gradient(135deg,#eff6ff 0%,#dbeafe 52%,#ecfdf5 100%);color:#1e3a8a;border-radius:999px;padding:4px 8px;font-size:10px;font-weight:900;line-height:1;box-shadow:0 0 0 2px rgba(37,99,235,.08),0 4px 12px rgba(37,99,235,.16);animation:developerBadgePulse 2.2s ease-in-out infinite}
.developer-admin-badge.compact{margin-top:6px;padding:3px 7px;font-size:10px}
.developer-admin-badge small{color:#047857;font-size:10px;font-weight:900}
.developer-admin-icon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:999px;background:#ffffff;color:#111827;font-size:16px;font-weight:900;line-height:1;letter-spacing:0;box-shadow:inset 0 0 0 1px rgba(37,99,235,.18),0 1px 5px rgba(37,99,235,.18);animation:developerIconPulse 1.6s ease-in-out infinite}
.developer-admin-label{white-space:nowrap}
.today-role-employee.dashboard-developer-member{background:linear-gradient(135deg,#ffffff 0%,#eff6ff 48%,#dcfce7 100%);border-color:#60a5fa;box-shadow:inset 4px 0 0 #2563eb,0 0 0 2px rgba(37,99,235,.08),0 6px 18px rgba(37,99,235,.16);padding-right:12px;animation:developerTilePulse 2.4s ease-in-out infinite}
.today-role-employee.dashboard-developer-member:hover{background:linear-gradient(135deg,#f8fcff 0%,#dbeafe 52%,#bbf7d0 100%);border-color:#2563eb;animation-play-state:paused}
.today-role-employee.weekend-login-member{background:#fffbeb;border-color:#fcd34d;box-shadow:inset 4px 0 0 rgba(245,158,11,.56);animation:weekendLoginTilePulse 2.4s ease-in-out infinite}
.today-role-employee.weekend-login-member:hover{background:#fff7d6;border-color:#f59e0b;animation-play-state:paused}
.today-role-employee.dashboard-developer-member.weekend-login-member{background:linear-gradient(135deg,#eff6ff 0%,#fff7cc 56%,#dcfce7 100%);border-color:#60a5fa;box-shadow:inset 4px 0 0 #2563eb,0 0 0 2px rgba(37,99,235,.1),0 6px 18px rgba(37,99,235,.16)}
.today-role-employee.new-login-member{background:#fff7cc;border-color:#f59e0b;box-shadow:inset 4px 0 0 #f59e0b,0 2px 7px rgba(245,158,11,.16);padding-right:48px}
.today-role-employee.weekend-login-member.new-login-member{background:#fff7cc;border-color:#f59e0b;box-shadow:inset 4px 0 0 #f59e0b,0 2px 7px rgba(245,158,11,.16)}
.today-role-employee.new-login-member:after{content:'New';position:absolute;top:7px;right:8px;background:#f59e0b;color:#78350f;border-radius:999px;padding:2px 6px;font-size:10px;font-weight:900;line-height:1}
.today-role-employee b{display:block;color:#111827;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.today-role-employee a{color:#2563eb;text-decoration:none}
.today-role-employee a:hover{text-decoration:underline}
.today-role-employee small{display:block;color:#64748b;font-size:11px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.table-link+.developer-admin-badge.compact,td>.developer-admin-badge.compact{margin:0 0 0 7px}
.weekend-login-badge{display:inline-block;margin-top:6px;border:1px solid #fcd34d;background:#fef3c7;color:#92400e;border-radius:999px;padding:2px 7px;font-size:10px;font-weight:900;line-height:1;animation:weekendLoginBadgePulse 1.8s ease-in-out infinite;transform-origin:center}
.today-role-no-employees{color:#64748b;font-weight:800;padding:8px}
.employee-popup-backdrop{display:none;position:fixed;z-index:9999;inset:0;background:rgba(15,23,42,.42);align-items:center;justify-content:center;padding:20px}
.employee-popup{width:min(460px,94vw);background:#fff;border:1px solid #dbeafe;border-radius:6px;box-shadow:0 18px 55px rgba(15,23,42,.28);overflow:hidden}
.employee-popup-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;background:linear-gradient(135deg,#f8fcff 0%,#eef6ff 100%);border-bottom:1px solid #dbeafe;padding:14px}
.employee-popup-head h2{font-size:16px;line-height:1.2;margin:0;color:#111827;font-weight:800}
.employee-popup-head span{display:block;margin-top:4px;color:#64748b;font-size:12px;font-weight:800}
.employee-popup-head .developer-popup-badge{align-items:center;width:max-content;margin-top:8px;color:#1e3a8a}
.employee-popup-head .developer-popup-badge span,.employee-popup-head .developer-popup-badge small{margin-top:0}
.employee-popup-head .developer-popup-badge .developer-admin-badge{display:inline-flex;color:#1e3a8a}
.employee-popup-head .developer-popup-badge .developer-admin-icon{display:inline-flex;color:#111827}
.employee-popup-head .developer-popup-badge .developer-admin-label{display:inline;color:#1e3a8a}
.employee-popup-head .developer-popup-badge small{display:inline;color:#047857}
.employee-popup-backdrop.dashboard-developer-popup .employee-popup{border-color:#60a5fa;box-shadow:0 20px 60px rgba(37,99,235,.32)}
.employee-popup-close{width:30px;height:30px;border:1px solid #cbd5e1;background:#fff;border-radius:4px;color:#334155;font-weight:800;cursor:pointer}
.employee-popup-close:hover{background:#eff6ff;border-color:#93c5fd;color:#1d4ed8}
.employee-popup-body{padding:12px 14px}
.employee-popup-row{display:grid;grid-template-columns:150px minmax(0,1fr);gap:12px;border-bottom:1px solid #eef2f7;padding:10px 0}
.employee-popup-row:last-child{border-bottom:0}
.employee-popup-row span{color:#64748b;font-size:11px;font-weight:800;text-transform:uppercase}
.employee-popup-row b{color:#111827;font-size:13px;font-weight:800;min-width:0;overflow-wrap:anywhere}
.employee-popup-link{display:inline-block;margin:0 14px 14px;border:1px solid #bfdbfe;background:#eff6ff;color:#1d4ed8;border-radius:4px;padding:8px 10px;font-size:12px;font-weight:800;text-decoration:none}
.employee-popup-link:hover{background:#dbeafe;text-decoration:none}
.role-trend-panel{margin-bottom:14px;background:#fff}
.role-chart-wrap svg{display:block;width:100%;height:auto;min-height:320px}
.role-chart-bg{fill:url(#roleTrendBackground);stroke:#e5e7eb;stroke-width:1}
.monthly-role-month-highlight{display:none;fill:#fffbeb;stroke:#f59e0b;stroke-width:1;opacity:.86;pointer-events:none}
.monthly-role-month-highlight.active{display:block}
.monthly-role-segment{cursor:pointer;outline:none}
.monthly-role-selection{display:none;fill:transparent;stroke:#f59e0b;stroke-width:1.2;pointer-events:none}
.monthly-role-segment.active .monthly-role-selection{display:block}
.monthly-role-rect{shape-rendering:geometricPrecision}
.monthly-role-highlight{fill:#fff;opacity:.14;pointer-events:none}
.monthly-role-segment:hover .monthly-role-rect{stroke:#475569;stroke-width:1}
.monthly-role-segment.active .monthly-role-rect{stroke:#b45309;stroke-width:1}
.grid-line{stroke:#e5eaf0;stroke-width:1}
.axis-line{stroke:#94a3b8;stroke-width:1.1}
.axis-label{font-size:10px;fill:#64748b}
.month-axis-label{font-size:10px;fill:#475569;font-weight:700}
.bar-total-label{font-size:10px;fill:#334155;font-weight:700;pointer-events:none}
.monthly-total-line-shadow{fill:none;stroke:#ffffff;stroke-width:7;stroke-linecap:round;stroke-linejoin:round;opacity:.76;pointer-events:none}
.monthly-total-line{fill:none;stroke:#7c3aed;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
.monthly-total-point{pointer-events:none}
.monthly-total-point-ring{fill:#ffffff;stroke:#7c3aed;stroke-width:2.1}
.monthly-total-point-core{fill:#7c3aed}
.monthly-total-line-legend text{font-size:10px;fill:#4c1d95;font-weight:800}
.role-legend{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px 0}
.role-legend-item{display:grid;grid-template-columns:9px auto minmax(72px,1fr);align-items:center;gap:6px;border:1px solid #e5e7eb;background:#fff;border-radius:4px;padding:5px 8px;min-width:150px;max-width:240px;color:#1f2937}
.role-legend-item:hover{filter:saturate(1.06) brightness(1.01)}
.role-legend-dot{width:9px;height:9px;border-radius:50%;box-shadow:0 0 0 2px rgba(255,255,255,.72)}
.role-legend-item b{font-size:10px;color:#1f2937;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.role-legend-item small{font-size:10px;color:#111827;font-weight:800;min-width:26px;text-align:right}
.role-tile-label{display:inline-grid;grid-template-columns:10px minmax(0,1fr);align-items:center;gap:10px;box-sizing:border-box;max-width:100%;min-width:210px;border:1px solid #d7e0ea;border-radius:4px;padding:7px 10px;color:#1f2937;font-weight:700}
.role-tile-label:hover{filter:saturate(1.03) brightness(1.01)}
.role-tile-dot{width:10px;height:10px;border-radius:50%;box-shadow:0 0 0 2px rgba(255,255,255,.9)}
.role-tile-text{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.role-matrix td:first-child .role-tile-label{width:100%;min-width:230px}
.kpi-role-summary-table .role-tile-label{min-width:190px}
.monthly-role-detail{border:1px solid #dbeafe;background:#fff;border-radius:4px;margin-top:10px;padding:12px}
.monthly-role-detail-empty{color:#64748b;font-weight:800;text-align:center;padding:14px}
.role-matrix-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:12px}
.role-matrix-head b{display:block;color:#111827;font-size:13px}
.role-matrix-head span{display:block;color:#64748b;font-size:12px;font-weight:800;margin-top:2px}
.role-matrix-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;white-space:nowrap}
.role-matrix-scroll{overflow:auto;margin-top:12px;border:1px solid #e5e7eb;border-radius:4px;background:#fff}
.role-matrix{width:100%;border-collapse:collapse;font-size:12px}
.role-matrix th{position:sticky;top:0;background:#f8fafc;color:#334155;border-bottom:1px solid #cbd5e1;padding:8px 9px;text-align:right;white-space:nowrap;font-weight:800}
.role-matrix th:first-child,.role-matrix td:first-child{text-align:left;min-width:240px}
.role-matrix td{border-bottom:1px solid #e5e7eb;padding:8px 9px;text-align:right;color:#1f2937;white-space:nowrap}
.role-matrix tbody tr:nth-child(even) td{background:#fbfdff}
.role-matrix-count{appearance:none;display:block;box-sizing:border-box;width:100%;border:0;border-radius:4px;padding:4px 8px;min-width:34px;text-align:center;font:inherit;font-weight:800;line-height:1.2;cursor:pointer}
.role-matrix-count:hover{filter:saturate(1.08) brightness(1.03);box-shadow:inset 0 0 0 1px #10b981,0 1px 4px rgba(16,185,129,.18)!important}
.role-matrix-count.active{background:#fde68a!important;color:#78350f!important;box-shadow:inset 0 0 0 1px #f59e0b,0 0 0 2px #fef3c7!important}
.role-matrix-count.highest-value{position:relative;background:linear-gradient(135deg,#dcfce7 0%,#86efac 50%,#22c55e 100%)!important;color:#064e3b!important;box-shadow:inset 0 0 0 1px rgba(21,128,61,.32),0 0 0 3px rgba(34,197,94,.2),0 5px 12px rgba(34,197,94,.18)!important;animation:highestMatrixValuePulse 1.9s ease-in-out infinite}
.role-matrix-count:focus{outline:2px solid #2563eb;outline-offset:1px}
.role-swatch{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;vertical-align:middle}
.detail-filter-bar{display:grid;grid-template-columns:minmax(220px,1.3fr) minmax(180px,1fr) minmax(150px,.75fr) minmax(160px,.75fr) auto;gap:10px;align-items:end;margin:10px 0 12px 0;padding:10px;border:1px solid #e5e7eb;background:#fbfdff;border-radius:4px}
.detail-filter-bar label{display:block;min-width:0}
.detail-filter-bar label span{display:block;color:#64748b;font-size:10px;font-weight:800;text-transform:uppercase;margin-bottom:4px}
.detail-filter-bar input,.detail-filter-bar select{box-sizing:border-box;width:100%;border:1px solid #cbd5e1;background:#fff;color:#111827;border-radius:4px;padding:7px 8px;font-size:12px;font-weight:700;min-height:34px}
.detail-filter-bar input:focus,.detail-filter-bar select:focus{outline:2px solid #bfdbfe;border-color:#2563eb}
.detail-filter-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;white-space:nowrap}
.detail-filter-actions span{color:#64748b;font-size:12px;font-weight:800}
.table-scroll{overflow:auto;max-height:680px;border-top:1px solid #e5e7eb}
.result-table{width:100%;border-collapse:collapse;font-size:12px}
.result-table th{position:sticky;top:0;z-index:2;text-align:left;background:#f8fafc;color:#334155;border-bottom:1px solid #cbd5e1;padding:10px;font-weight:800;white-space:nowrap}
.result-table th.sortable{padding:0}
.sort-header{appearance:none;border:0;background:transparent;color:inherit;font:inherit;font-weight:800;width:100%;min-height:38px;padding:10px;display:flex;align-items:center;gap:6px;text-align:left;cursor:pointer}
.sort-header:hover,.sort-header.active{background:#eef6ff;color:#111827}
.sort-header:focus{outline:2px solid #2563eb;outline-offset:-2px}
.sort-indicator{display:inline-block;width:0;height:0;flex:0 0 auto;margin-left:2px;border-left:4px solid transparent;border-right:4px solid transparent;opacity:.32}
.sort-indicator.asc{border-bottom:6px solid #2563eb;opacity:1}
.sort-indicator.desc{border-top:6px solid #2563eb;opacity:1}
.result-table td{border-bottom:1px solid #e5e7eb;padding:9px 10px;vertical-align:top;color:#1f2937}
.result-table tbody tr:nth-child(even) td{background:#fbfdff}
.result-table tr.weekend-login-row td{background:#fffbeb;box-shadow:inset 0 1px 0 rgba(245,158,11,.08),inset 0 -1px 0 rgba(245,158,11,.08)}
.result-table tr.weekend-login-row td:first-child{box-shadow:inset 4px 0 0 rgba(245,158,11,.58),inset 0 1px 0 rgba(245,158,11,.08),inset 0 -1px 0 rgba(245,158,11,.08);animation:weekendLoginRowPulse 2.4s ease-in-out infinite}
.result-table tr:hover td{background:#f8fafc}
.result-table tr.weekend-login-row:hover td{background:#fff7d6}
.table-link{color:#2563eb;font-weight:800;text-decoration:none}
.table-link:hover{text-decoration:underline}
.weekend-login-table-badge{display:inline-block;margin-left:8px;border:1px solid #fcd34d;background:#fef3c7;color:#92400e;border-radius:999px;padding:2px 7px;font-size:10px;font-weight:900;line-height:1;vertical-align:middle;animation:weekendLoginBadgePulse 1.8s ease-in-out infinite;transform-origin:center}
@keyframes weekendLoginTilePulse{0%,100%{box-shadow:inset 4px 0 0 rgba(245,158,11,.56)}50%{box-shadow:inset 4px 0 0 #f59e0b,0 0 0 3px rgba(245,158,11,.22),0 6px 18px rgba(245,158,11,.16)}}
@keyframes weekendLoginBadgePulse{0%,100%{transform:scale(1);box-shadow:0 0 0 0 rgba(245,158,11,.34)}50%{transform:scale(1.06);box-shadow:0 0 0 4px rgba(245,158,11,0)}}
@keyframes weekendLoginRowPulse{0%,100%{box-shadow:inset 4px 0 0 rgba(245,158,11,.58),inset 0 1px 0 rgba(245,158,11,.08),inset 0 -1px 0 rgba(245,158,11,.08)}50%{box-shadow:inset 6px 0 0 #f59e0b,inset 0 1px 0 rgba(245,158,11,.16),inset 0 -1px 0 rgba(245,158,11,.16),0 0 0 2px rgba(245,158,11,.16)}}
@keyframes developerTilePulse{0%,100%{box-shadow:inset 4px 0 0 #2563eb,0 0 0 2px rgba(37,99,235,.08),0 6px 18px rgba(37,99,235,.16)}50%{box-shadow:inset 6px 0 0 #1d4ed8,0 0 0 4px rgba(37,99,235,.12),0 10px 24px rgba(37,99,235,.24)}}
@keyframes developerBadgePulse{0%,100%{transform:translateY(0);box-shadow:0 0 0 2px rgba(37,99,235,.08),0 4px 12px rgba(37,99,235,.16)}50%{transform:translateY(-1px);box-shadow:0 0 0 4px rgba(37,99,235,.1),0 8px 18px rgba(37,99,235,.24)}}
@keyframes developerIconPulse{0%,100%{transform:scale(1);box-shadow:inset 0 0 0 1px rgba(37,99,235,.18),0 1px 5px rgba(37,99,235,.18)}50%{transform:scale(1.08);box-shadow:inset 0 0 0 1px rgba(4,120,87,.22),0 0 0 3px rgba(37,99,235,.1),0 4px 10px rgba(4,120,87,.2)}}
@keyframes highestMatrixValuePulse{0%,100%{transform:scale(1);box-shadow:inset 0 0 0 1px rgba(21,128,61,.32),0 0 0 3px rgba(34,197,94,.2),0 5px 12px rgba(34,197,94,.18)}50%{transform:scale(1.07);box-shadow:inset 0 0 0 1px rgba(21,128,61,.46),0 0 0 6px rgba(34,197,94,.08),0 9px 18px rgba(34,197,94,.3)}}
@media(prefers-reduced-motion:reduce){.today-role-employee.weekend-login-member,.today-role-employee.dashboard-developer-member,.developer-admin-badge,.developer-admin-icon,.weekend-login-badge,.weekend-login-table-badge,.result-table tr.weekend-login-row td:first-child,.role-matrix-count.highest-value{animation:none!important}}
.status-pill{display:inline-block;border-radius:999px;padding:4px 9px;font-weight:800;font-size:11px}
.status-pill.success{background:#ccfbf1;color:#115e59}
.status-pill.failed{background:#ffedd5;color:#9a3412}
.status-pill.unknown{background:#e2e8f0;color:#334155}
.empty-chart{height:160px;display:flex;align-items:center;justify-content:center;color:#64748b;font-weight:700;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:4px}
.dash-footer{display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:14px;padding:12px 2px 0;border-top:1px solid #e5e7eb;color:#64748b;font-size:12px;font-weight:700}
.developer-credit{display:inline-flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.developer-credit strong{color:#111827;font-weight:900}
.version-badge{background:#eef2ff;border:1px solid #dbeafe;color:#334155;border-radius:999px;padding:3px 8px;font-weight:800}
@media(max-width:900px){.department-distribution-body{grid-template-columns:1fr}.department-donut-wrap{min-height:260px}.department-ranking-table-wrap{max-height:360px}}
@media(max-width:1100px){.kpi-grid{grid-template-columns:repeat(2,1fr)}.detail-filter-bar{grid-template-columns:repeat(2,minmax(180px,1fr))}}
@media(max-width:760px){.dash-topbar{align-items:flex-start;flex-direction:column}.dash-actions{width:100%;flex-direction:column;align-items:stretch}.auto-refresh-toggle,.auto-refresh-frequency{width:100%;box-sizing:border-box}.auto-refresh-status{min-width:0}.btn{width:100%}.kpi-grid{grid-template-columns:1fr}.detail-filter-bar{grid-template-columns:1fr}.detail-filter-actions,.role-matrix-actions{width:100%;align-items:stretch;flex-direction:column}.today-role-detail-head,.role-matrix-head{align-items:flex-start;flex-direction:column}.dash-footer{justify-content:flex-start}}
</style>`;
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escAttr(value) {
    return esc(value).replace(/`/g, '&#096;');
  }

  return { onRequest };
});
