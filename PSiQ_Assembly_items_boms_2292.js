/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * Ramakrishna Ambati  04/14/2026
 * Manufacturing Dashboard
 */
define(['N/search', 'N/ui/serverWidget', 'N/url', 'N/runtime'], (search, serverWidget, url, runtime) => {
  const PAGE_SIZE = 100;
  const MAX_DEPTH = 10;
  const LOCATION_ID = null;

  const onRequest = (context) => {
    const request = context.request;

    const mode = request.parameters.mode || 'list';
    const pageIndex = Math.max(parseInt(request.parameters.page || '0', 10) || 0, 0);
    const assemblyFilter = (request.parameters.assembly || '').trim();

    const form = serverWidget.createForm({
      title: 'Manufacturing Dashboard'
    });

    const htmlField = form.addField({
      id: 'custpage_html',
      type: serverWidget.FieldType.INLINEHTML,
      label: 'Manufacturing Dashboard'
    });

    let listData = null;
    let explosionData = null;
    let errorMessage = '';

    const dashboard = getDashboardMetrics();

    if (mode === 'explode' && assemblyFilter) {
      const rootAssembly = findAssemblyByItemId(assemblyFilter);

      if (rootAssembly) {
        explosionData = buildBomExplosion(rootAssembly);
      } else {
        errorMessage = 'No active assembly found for "' + assemblyFilter + '".';
      }
    } else {
      listData = getAssemblyListData(pageIndex, assemblyFilter);
    }

    htmlField.defaultValue = buildHtml({
      dashboard,
      listData,
      explosionData,
      mode,
      pageIndex,
      assemblyFilter,
      errorMessage,
      scriptUrl: getCurrentSuiteletUrl()
    });

    context.response.writePage(form);
  };

  const getDashboardMetrics = () => {
    const totalAssemblies = countSearch(search.create({
      type: search.Type.ITEM,
      filters: [
        ['type', 'anyof', 'Assembly'],
        'AND',
        ['isinactive', 'is', 'F']
      ],
      columns: ['internalid']
    }));

    const inactiveAssemblies = countSearch(search.create({
      type: search.Type.ITEM,
      filters: [
        ['type', 'anyof', 'Assembly'],
        'AND',
        ['isinactive', 'is', 'T']
      ],
      columns: ['internalid']
    }));

    const assembliesWithComponents = countAssembliesWithComponents();
    const missingBomCount = Math.max(totalAssemblies - assembliesWithComponents, 0);

    return {
      totalAssemblies,
      inactiveAssemblies,
      assembliesWithComponents,
      missingBomCount,
      topLargeBoms: getTopLargeBoms(),
      placeholderComponents: getPlaceholderComponents()
    };
  };

  const countSearch = (s) => {
    try {
      return s.runPaged({ pageSize: 1000 }).count || 0;
    } catch (e) {
      return 0;
    }
  };

  const countAssembliesWithComponents = () => {
    const seen = {};

    const s = search.create({
      type: search.Type.ITEM,
      filters: [
        ['type', 'anyof', 'Assembly'],
        'AND',
        ['isinactive', 'is', 'F']
      ],
      columns: [
        search.createColumn({ name: 'internalid' }),
        search.createColumn({ name: 'memberitem' })
      ]
    });

    s.run().each((r) => {
      const assemblyId = r.getValue({ name: 'internalid' });
      const memberText = r.getText({ name: 'memberitem' });
      const memberValue = r.getValue({ name: 'memberitem' });

      if (assemblyId && (memberText || memberValue)) {
        seen[assemblyId] = true;
      }

      return true;
    });

    return Object.keys(seen).length;
  };

  const getTopLargeBoms = () => {
    const map = {};

    const s = search.create({
      type: search.Type.ITEM,
      filters: [
        ['type', 'anyof', 'Assembly'],
        'AND',
        ['isinactive', 'is', 'F']
      ],
      columns: [
        search.createColumn({ name: 'internalid' }),
        search.createColumn({ name: 'itemid' }),
        search.createColumn({ name: 'displayname' }),
        search.createColumn({ name: 'memberitem' })
      ]
    });

    s.run().each((r) => {
      const id = r.getValue({ name: 'internalid' });
      const memberText = r.getText({ name: 'memberitem' });
      const memberValue = r.getValue({ name: 'memberitem' });

      if (!map[id]) {
        map[id] = {
          assembly: r.getValue({ name: 'itemid' }) || '',
          description: r.getValue({ name: 'displayname' }) || '',
          count: 0
        };
      }

      if (memberText || memberValue) {
        map[id].count++;
      }

      return true;
    });

    return Object.keys(map)
      .map((id) => map[id])
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  };

  const getPlaceholderComponents = () => {
    const patterns = [
      'placeholder',
      'dummy',
      'temp',
      'temporary',
      'tbd',
      'todo',
      'sample',
      'test part',
      'fake',
      'proto'
    ];

    const rows = [];

    const s = search.create({
      type: search.Type.ITEM,
      filters: [
        ['type', 'anyof', 'Assembly'],
        'AND',
        ['isinactive', 'is', 'F']
      ],
      columns: [
        search.createColumn({ name: 'itemid' }),
        search.createColumn({ name: 'displayname' }),
        search.createColumn({ name: 'memberitem' }),
        search.createColumn({ name: 'salesdescription', join: 'memberitem' })
      ]
    });

    s.run().each((r) => {
      const component = r.getText({ name: 'memberitem' }) || '';
      const componentDescription =
        r.getValue({ name: 'salesdescription', join: 'memberitem' }) || '';

      const haystack = (component + ' ' + componentDescription).toLowerCase();
      const isPlaceholder = patterns.some((p) => haystack.indexOf(p) !== -1);

      if (isPlaceholder) {
        rows.push({
          assembly: r.getValue({ name: 'itemid' }) || '',
          assemblyDescription: r.getValue({ name: 'displayname' }) || '',
          component,
          componentDescription
        });
      }

      return rows.length < 10;
    });

    return rows;
  };

  const getAssemblyListData = (pageIndex, assemblyFilter) => {
    const assemblyPage = getAssemblyIdsForPage(pageIndex, assemblyFilter);

    if (assemblyPage.ids.length === 0) {
      return {
        assemblies: [],
        totalCount: assemblyPage.totalCount,
        pageCount: assemblyPage.pageCount,
        hasNextPage: false
      };
    }

    const bomRows = getBomRowsForAssemblies(assemblyPage.ids);
    const assemblyMap = {};

    bomRows.forEach((row) => {
      if (!assemblyMap[row.assemblyId]) {
        assemblyMap[row.assemblyId] = {
          id: row.assemblyId,
          name: row.assemblyName,
          description: row.assemblyDescription,
          components: []
        };
      }

      if (row.componentName) {
        assemblyMap[row.assemblyId].components.push({
          id: row.componentId,
          item: row.componentName,
          description: row.componentDescription,
          quantity: row.quantity,
          units: row.units,
          availableQty: row.availableQty,
          status: getStatus(row.quantity, row.availableQty),
          isAssembly: row.isAssembly
        });
      }
    });

    assemblyPage.ids.forEach((asm) => {
      if (!assemblyMap[asm.id]) {
        assemblyMap[asm.id] = {
          id: asm.id,
          name: asm.name,
          description: asm.description,
          components: []
        };
      }
    });

    return {
      assemblies: assemblyPage.ids.map((asm) => assemblyMap[asm.id]),
      totalCount: assemblyPage.totalCount,
      pageCount: assemblyPage.pageCount,
      hasNextPage: pageIndex < assemblyPage.pageCount - 1
    };
  };

  const getAssemblyIdsForPage = (pageIndex, assemblyFilter) => {
    const filters = [
      ['type', 'anyof', 'Assembly'],
      'AND',
      ['isinactive', 'is', 'F']
    ];

    if (assemblyFilter) {
      filters.push('AND');
      filters.push([
        ['itemid', 'contains', assemblyFilter],
        'OR',
        ['displayname', 'contains', assemblyFilter],
        'OR',
        ['salesdescription', 'contains', assemblyFilter]
      ]);
    }

    const asmSearch = search.create({
      type: search.Type.ITEM,
      filters,
      columns: [
        search.createColumn({ name: 'internalid', sort: search.Sort.ASC }),
        search.createColumn({ name: 'itemid' }),
        search.createColumn({ name: 'displayname' }),
        search.createColumn({ name: 'salesdescription' })
      ]
    });

    const paged = asmSearch.runPaged({
      pageSize: PAGE_SIZE
    });

    if (paged.pageRanges.length === 0 || pageIndex >= paged.pageRanges.length) {
      return {
        ids: [],
        totalCount: paged.count,
        pageCount: paged.pageRanges.length
      };
    }

    const page = paged.fetch({
      index: pageIndex
    });

    return {
      ids: page.data.map((r) => ({
        id: r.getValue({ name: 'internalid' }),
        name: r.getValue({ name: 'itemid' }),
        description:
          r.getValue({ name: 'displayname' }) ||
          r.getValue({ name: 'salesdescription' }) ||
          ''
      })),
      totalCount: paged.count,
      pageCount: paged.pageRanges.length
    };
  };

  const getBomRowsForAssemblies = (assemblies) => {
    const ids = assemblies.map((asm) => asm.id);

    const itemSearch = search.create({
      type: search.Type.ITEM,
      filters: [
        ['internalid', 'anyof', ids],
        'AND',
        ['type', 'anyof', 'Assembly'],
        'AND',
        ['isinactive', 'is', 'F']
      ],
      columns: [
        search.createColumn({ name: 'internalid', sort: search.Sort.ASC }),
        search.createColumn({ name: 'itemid' }),
        search.createColumn({ name: 'displayname' }),
        search.createColumn({ name: 'salesdescription' }),
        search.createColumn({ name: 'memberitem' }),
        search.createColumn({ name: 'memberquantity' }),
        search.createColumn({ name: 'memberunit' }),
        search.createColumn({ name: 'itemid', join: 'memberitem' }),
        search.createColumn({ name: 'displayname', join: 'memberitem' }),
        search.createColumn({ name: 'salesdescription', join: 'memberitem' }),
        search.createColumn({ name: 'type', join: 'memberitem' }),
        search.createColumn({ name: 'stockunit', join: 'memberitem' }),
        search.createColumn({ name: 'quantityavailable', join: 'memberitem' })
      ]
    });

    const rows = [];

    itemSearch.run().each((r) => {
      const componentType =
        r.getText({ name: 'type', join: 'memberitem' }) ||
        r.getValue({ name: 'type', join: 'memberitem' }) ||
        '';

      rows.push({
        assemblyId: r.getValue({ name: 'internalid' }),
        assemblyName: r.getValue({ name: 'itemid' }),
        assemblyDescription:
          r.getValue({ name: 'displayname' }) ||
          r.getValue({ name: 'salesdescription' }) ||
          '',
        componentId: r.getValue({ name: 'memberitem' }),
        componentName:
          r.getValue({ name: 'itemid', join: 'memberitem' }) ||
          r.getText({ name: 'memberitem' }) ||
          '',
        componentDescription:
          r.getValue({ name: 'displayname', join: 'memberitem' }) ||
          r.getValue({ name: 'salesdescription', join: 'memberitem' }) ||
          '',
        quantity: parseNumber(r.getValue({ name: 'memberquantity' })),
        units:
          r.getText({ name: 'memberunit' }) ||
          r.getValue({ name: 'memberunit' }) ||
          r.getText({ name: 'stockunit', join: 'memberitem' }) ||
          r.getValue({ name: 'stockunit', join: 'memberitem' }) ||
          '',
        availableQty: parseNumber(r.getValue({ name: 'quantityavailable', join: 'memberitem' })),
        isAssembly: String(componentType).toLowerCase().indexOf('assembly') !== -1
      });

      return true;
    });

    return rows;
  };

  const findAssemblyByItemId = (assemblyInput) => {
    const s = search.create({
      type: search.Type.ITEM,
      filters: [
        ['type', 'anyof', 'Assembly'],
        'AND',
        ['isinactive', 'is', 'F'],
        'AND',
        [
          ['itemid', 'is', assemblyInput],
          'OR',
          ['itemid', 'contains', assemblyInput]
        ]
      ],
      columns: [
        search.createColumn({ name: 'internalid', sort: search.Sort.ASC }),
        search.createColumn({ name: 'itemid' }),
        search.createColumn({ name: 'displayname' }),
        search.createColumn({ name: 'salesdescription' })
      ]
    });

    let assembly = null;

    s.run().each((r) => {
      assembly = {
        id: r.getValue({ name: 'internalid' }),
        item: r.getValue({ name: 'itemid' }) || '',
        description:
          r.getValue({ name: 'displayname' }) ||
          r.getValue({ name: 'salesdescription' }) ||
          ''
      };

      return false;
    });

    return assembly;
  };

  const buildBomExplosion = (rootAssembly) => {
    const bomCache = {};
    const availabilityCache = {};
    const flatRows = [];

    const rootAvailability = getAvailability(rootAssembly.id, availabilityCache);

    const rootNode = {
      id: rootAssembly.id,
      item: rootAssembly.item,
      description: rootAssembly.description,
      level: 0,
      requiredQty: 1,
      availableQty: rootAvailability.availableQty,
      onHandQty: rootAvailability.onHandQty,
      onOrderQty: rootAvailability.onOrderQty,
      units: rootAvailability.units,
      status: getStatus(1, rootAvailability.availableQty),
      isAssembly: true,
      children: []
    };

    explodeBom({
      node: rootNode,
      parentQty: 1,
      level: 0,
      path: {},
      bomCache,
      availabilityCache,
      flatRows
    });

    return {
      root: rootNode,
      flatRows,
      summary: summarizeTree(rootNode)
    };
  };

  const explodeBom = ({
    node,
    parentQty,
    level,
    path,
    bomCache,
    availabilityCache,
    flatRows
  }) => {
    if (level >= MAX_DEPTH) return;

    if (path[node.id]) {
      node.circularReference = true;
      return;
    }

    path[node.id] = true;

    const components = getBomComponents(node.id, bomCache);

    components.forEach((component) => {
      const requiredQty = multiplyQty(parentQty, component.quantity);
      const availability = getAvailability(component.id, availabilityCache);

      const childNode = {
        id: component.id,
        item: component.item,
        description: component.description,
        level: level + 1,
        quantityPer: component.quantity,
        requiredQty,
        availableQty: availability.availableQty,
        onHandQty: availability.onHandQty,
        onOrderQty: availability.onOrderQty,
        units: component.units || availability.units,
        status: getStatus(requiredQty, availability.availableQty),
        isAssembly: component.isAssembly,
        children: []
      };

      node.children.push(childNode);
      flatRows.push(childNode);

      if (component.isAssembly) {
        explodeBom({
          node: childNode,
          parentQty: requiredQty,
          level: level + 1,
          path: Object.assign({}, path),
          bomCache,
          availabilityCache,
          flatRows
        });
      }
    });
  };

  const getBomComponents = (assemblyId, bomCache) => {
    if (bomCache[assemblyId]) return bomCache[assemblyId];

    const components = [];

    const s = search.create({
      type: search.Type.ITEM,
      filters: [
        ['internalid', 'anyof', assemblyId],
        'AND',
        ['type', 'anyof', 'Assembly'],
        'AND',
        ['isinactive', 'is', 'F']
      ],
      columns: [
        search.createColumn({ name: 'memberitem' }),
        search.createColumn({ name: 'memberquantity' }),
        search.createColumn({ name: 'memberunit' }),
        search.createColumn({ name: 'itemid', join: 'memberitem' }),
        search.createColumn({ name: 'displayname', join: 'memberitem' }),
        search.createColumn({ name: 'salesdescription', join: 'memberitem' }),
        search.createColumn({ name: 'type', join: 'memberitem' }),
        search.createColumn({ name: 'stockunit', join: 'memberitem' })
      ]
    });

    s.run().each((r) => {
      const componentId = r.getValue({ name: 'memberitem' });
      const componentType =
        r.getText({ name: 'type', join: 'memberitem' }) ||
        r.getValue({ name: 'type', join: 'memberitem' }) ||
        '';

      if (componentId) {
        components.push({
          id: componentId,
          item:
            r.getValue({ name: 'itemid', join: 'memberitem' }) ||
            r.getText({ name: 'memberitem' }) ||
            '',
          description:
            r.getValue({ name: 'displayname', join: 'memberitem' }) ||
            r.getValue({ name: 'salesdescription', join: 'memberitem' }) ||
            '',
          quantity: parseNumber(r.getValue({ name: 'memberquantity' })),
          units:
            r.getText({ name: 'memberunit' }) ||
            r.getValue({ name: 'memberunit' }) ||
            r.getText({ name: 'stockunit', join: 'memberitem' }) ||
            r.getValue({ name: 'stockunit', join: 'memberitem' }) ||
            '',
          isAssembly: String(componentType).toLowerCase().indexOf('assembly') !== -1
        });
      }

      return true;
    });

    bomCache[assemblyId] = components;
    return components;
  };

  const getAvailability = (itemId, availabilityCache) => {
    if (availabilityCache[itemId]) return availabilityCache[itemId];

    let availability = {
      availableQty: 0,
      onHandQty: 0,
      onOrderQty: 0,
      units: ''
    };

    try {
      if (LOCATION_ID) {
        availability = getLocationAvailability(itemId);
      } else {
        const lookup = search.lookupFields({
          type: search.Type.ITEM,
          id: itemId,
          columns: [
            'quantityavailable',
            'quantityonhand',
            'quantityonorder',
            'stockunit'
          ]
        });

        availability = {
          availableQty: parseNumber(lookup.quantityavailable),
          onHandQty: parseNumber(lookup.quantityonhand),
          onOrderQty: parseNumber(lookup.quantityonorder),
          units: getLookupText(lookup.stockunit)
        };
      }
    } catch (e) {
      availability = {
        availableQty: 0,
        onHandQty: 0,
        onOrderQty: 0,
        units: ''
      };
    }

    availabilityCache[itemId] = availability;
    return availability;
  };

  const getLocationAvailability = (itemId) => {
    let availability = {
      availableQty: 0,
      onHandQty: 0,
      onOrderQty: 0,
      units: ''
    };

    const s = search.create({
      type: search.Type.ITEM,
      filters: [
        ['internalid', 'anyof', itemId],
        'AND',
        ['inventorylocation', 'anyof', LOCATION_ID]
      ],
      columns: [
        search.createColumn({ name: 'locationquantityavailable' }),
        search.createColumn({ name: 'locationquantityonhand' }),
        search.createColumn({ name: 'quantityonorder' }),
        search.createColumn({ name: 'stockunit' })
      ]
    });

    s.run().each((r) => {
      availability = {
        availableQty: parseNumber(r.getValue({ name: 'locationquantityavailable' })),
        onHandQty: parseNumber(r.getValue({ name: 'locationquantityonhand' })),
        onOrderQty: parseNumber(r.getValue({ name: 'quantityonorder' })),
        units:
          r.getText({ name: 'stockunit' }) ||
          r.getValue({ name: 'stockunit' }) ||
          ''
      };

      return false;
    });

    return availability;
  };

  const summarizeTree = (rootNode) => {
    const allRows = [];

    const walk = (node) => {
      node.children.forEach((child) => {
        allRows.push(child);
        walk(child);
      });
    };

    walk(rootNode);

    return {
      totalComponents: allRows.length,
      shortageCount: allRows.filter((row) => row.status === 'SHORTAGE').length,
      lowCount: allRows.filter((row) => row.status === 'LOW').length,
      okCount: allRows.filter((row) => row.status === 'OK').length,
      maxDepth: allRows.reduce((max, row) => Math.max(max, row.level), 0)
    };
  };

  const getStatus = (requiredQty, availableQty) => {
    requiredQty = parseNumber(requiredQty);
    availableQty = parseNumber(availableQty);

    if (availableQty < requiredQty) return 'SHORTAGE';
    if (availableQty <= requiredQty * 1.25) return 'LOW';
    return 'OK';
  };

  const multiplyQty = (parentQty, componentQty) => {
    return roundQty(parseNumber(parentQty) * parseNumber(componentQty));
  };

  const roundQty = (value) => {
    return Math.round(parseNumber(value) * 100000) / 100000;
  };

  const parseNumber = (value) => {
    if (value === null || value === undefined || value === '') return 0;

    if (typeof value === 'object' && value.value !== undefined) {
      return parseNumber(value.value);
    }

    const parsed = parseFloat(String(value).replace(/,/g, ''));
    return isNaN(parsed) ? 0 : parsed;
  };

  const getLookupText = (value) => {
    if (!value) return '';

    if (Array.isArray(value) && value.length > 0) {
      return value[0].text || value[0].value || '';
    }

    if (typeof value === 'object') {
      return value.text || value.value || '';
    }

    return String(value);
  };

  const getCurrentSuiteletUrl = () => {
    const currentScript = runtime.getCurrentScript();

    return url.resolveScript({
      scriptId: currentScript.id,
      deploymentId: currentScript.deploymentId,
      returnExternalUrl: false
    });
  };

  const buildHtml = ({
    dashboard,
    listData,
    explosionData,
    mode,
    pageIndex,
    assemblyFilter,
    errorMessage,
    scriptUrl
  }) => {
    const missingBomPct = dashboard.totalAssemblies
      ? Math.round((dashboard.missingBomCount / dashboard.totalAssemblies) * 100)
      : 0;

    return `
      <style>
        .mf-wrap {
          font-family: Arial, Helvetica, sans-serif;
          padding: 24px;
          color: #172033;
          background: #f8fafc;
        }

        .mf-title {
          font-size: 30px;
          font-weight: 900;
          color: #263b59;
          margin-bottom: 6px;
        }

        .mf-subtitle {
          color: #667085;
          font-size: 13px;
          margin-bottom: 18px;
        }

        .kpi-grid {
          display: grid;
          grid-template-columns: repeat(5, minmax(160px, 1fr));
          gap: 14px;
          margin-bottom: 18px;
        }

        .kpi-card {
          background: white;
          border: 1px solid #e5e7eb;
          border-radius: 16px;
          padding: 16px;
          box-shadow: 0 3px 12px rgba(15, 23, 42, 0.06);
        }

        .kpi-label {
          color: #64748b;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          font-weight: 900;
        }

        .kpi-value {
          font-size: 30px;
          font-weight: 900;
          margin-top: 8px;
          color: #111827;
        }

        .kpi-note {
          font-size: 12px;
          color: #64748b;
          margin-top: 6px;
        }

        .blue { border-left: 6px solid #2563eb; }
        .green { border-left: 6px solid #22c55e; }
        .yellow { border-left: 6px solid #f59e0b; }
        .red { border-left: 6px solid #ef4444; }

        .search-card, .panel, .table-card {
          background: white;
          border: 1px solid #e5e7eb;
          border-radius: 16px;
          box-shadow: 0 3px 12px rgba(15, 23, 42, 0.06);
        }

        .collapsible-card {
          background: white;
          border: 1px solid #e5e7eb;
          border-radius: 16px;
          box-shadow: 0 3px 12px rgba(15, 23, 42, 0.06);
          margin-bottom: 18px;
          overflow: hidden;
        }

        .collapsible-header {
          width: 100%;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border: 0;
          background: linear-gradient(180deg, #ffffff, #f8fafc);
          padding: 14px 18px;
          cursor: pointer;
          color: #263b59;
          font-weight: 900;
          font-size: 15px;
          text-align: left;
          border-bottom: 1px solid #e5e7eb;
        }

        .collapsible-title {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .collapse-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          border-radius: 999px;
          background: #2563eb;
          color: white;
          font-size: 14px;
          font-weight: 900;
        }

        .collapsible-note {
          color: #64748b;
          font-size: 12px;
          font-weight: 700;
        }

        .collapsible-body {
          padding: 14px;
        }

        .collapsible-card.collapsed .collapsible-body {
          display: none;
        }

        .collapsible-card.collapsed .collapsible-header {
          border-bottom: 0;
        }

        .search-card {
          padding: 16px;
          margin-bottom: 18px;
        }

        .search-row {
          display: flex;
          gap: 10px;
          align-items: center;
          flex-wrap: wrap;
        }

        .search-input {
          width: 360px;
          max-width: 100%;
          border: 1px solid #cbd5e1;
          border-radius: 10px;
          padding: 11px 13px;
          font-size: 14px;
        }

        .btn {
          border: 0;
          border-radius: 10px;
          padding: 11px 16px;
          font-weight: 900;
          cursor: pointer;
          font-size: 13px;
        }

        .btn-primary { background: #2563eb; color: white; }
        .btn-muted { background: #f3f4f6; color: #374151; border: 1px solid #d1d5db; }
        .btn-disabled { opacity: 0.45; cursor: not-allowed; }

        .mode-tabs {
          display: flex;
          gap: 8px;
          margin-bottom: 18px;
        }

        .tab {
          padding: 10px 14px;
          border-radius: 999px;
          font-weight: 900;
          font-size: 13px;
          cursor: pointer;
          border: 1px solid #d1d5db;
          background: white;
          color: #334155;
        }

        .tab.active {
          background: #2563eb;
          color: white;
          border-color: #2563eb;
        }

        .dashboard-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 14px;
        }

        .panel-header {
          padding: 13px 15px;
          font-weight: 900;
          color: #263b59;
          border-bottom: 1px solid #e5e7eb;
          background: linear-gradient(180deg, #ffffff, #f8fafc);
        }

        .panel-body {
          padding: 10px 14px 14px 14px;
        }

        .mini-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
        }

        .mini-table td {
          padding: 8px 4px;
          border-bottom: 1px solid #eef2f7;
          vertical-align: top;
        }

        .mini-main { font-weight: 900; color: #111827; }
        .mini-sub { color: #64748b; font-size: 11px; margin-top: 2px; }

        .stats-row {
          display: flex;
          gap: 10px;
          margin: 12px 0 18px 0;
          flex-wrap: wrap;
        }

        .stat {
          background: #ffffff;
          border: 1px solid #e5e7eb;
          border-radius: 999px;
          padding: 7px 12px;
          font-size: 12px;
          color: #475569;
          font-weight: 900;
        }

        .table-card {
          overflow: hidden;
        }

        table.bom-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }

        .bom-table thead th {
          background: linear-gradient(180deg, #f8fafc, #eef2f7);
          color: #475569;
          text-transform: uppercase;
          font-size: 11px;
          letter-spacing: 0.04em;
          text-align: left;
          padding: 12px;
          border-bottom: 1px solid #e5e7eb;
        }

        .bom-table td {
          padding: 11px 12px;
          border-bottom: 1px solid #edf2f7;
          vertical-align: middle;
        }

        .assembly-row {
          background: white;
          cursor: pointer;
        }

        .assembly-row:hover { background: #f8fafc; }
        .assembly-row.open { background: #eaf3ff; }

        .expand-cell {
          width: 42px;
          text-align: center;
        }

        .expand-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          height: 24px;
          border-radius: 999px;
          background: #2563eb;
          color: white;
          font-weight: 900;
          font-size: 16px;
          box-shadow: 0 2px 5px rgba(37, 99, 235, 0.28);
        }

        .assembly-name, .component-name {
          font-weight: 900;
          color: #111827;
          font-size: 14px;
        }

        .assembly-desc {
          color: #64748b;
          font-size: 12px;
          margin-top: 3px;
        }

        .count-pill {
          background: #e0f2fe;
          color: #075985;
          padding: 5px 9px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 900;
        }

        .component-row { background: #fbfdff; }
        .component-cell { padding-left: 34px !important; }

        .tree-line {
          display: inline-block;
          width: 24px;
          height: 16px;
          border-left: 2px solid #cbd5e1;
          border-bottom: 2px solid #cbd5e1;
          margin-right: 8px;
          transform: translateY(-3px);
        }

        .component-badge {
          background: #fef3c7;
          color: #92400e;
          padding: 4px 8px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 900;
          margin-right: 8px;
        }

        .assembly-badge {
          background: #dbeafe;
          color: #1d4ed8;
          padding: 4px 8px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 900;
          margin-left: 8px;
        }

        .status {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          padding: 6px 10px;
          font-size: 12px;
          font-weight: 900;
        }

        .status-ok { background: #dcfce7; color: #166534; }
        .status-low { background: #fef3c7; color: #92400e; }
        .status-shortage { background: #fee2e2; color: #991b1b; }

        .qty { font-weight: 900; color: #111827; }

        .tree-header,
        .tree-row {
          display: grid;
          grid-template-columns: 1.8fr 1.3fr 110px 110px 110px 110px;
          gap: 10px;
          align-items: center;
        }

        .tree-header {
          background: linear-gradient(180deg, #f8fafc, #eef2f7);
          color: #475569;
          text-transform: uppercase;
          font-size: 11px;
          letter-spacing: 0.04em;
          font-weight: 900;
          padding: 13px 16px;
          border-bottom: 1px solid #e5e7eb;
        }

        .tree-row {
          padding: 12px 16px;
          border-bottom: 1px solid #edf2f7;
          font-size: 13px;
        }

        .tree-row.root { background: #eaf3ff; }
        .tree-row.assembly { background: #f8fbff; }

        .tree-indent { display: inline-block; }
        .tree-branch {
          color: #94a3b8;
          font-weight: 900;
          margin-right: 8px;
        }

        .error {
          background: #fee2e2;
          border: 1px solid #fecaca;
          color: #991b1b;
          padding: 14px;
          border-radius: 12px;
          font-weight: 900;
          margin-bottom: 18px;
        }

        .pager {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-top: 16px;
        }

        @media only screen and (max-width: 1200px) {
          .kpi-grid { grid-template-columns: repeat(2, minmax(160px, 1fr)); }
          .dashboard-grid { grid-template-columns: 1fr; }
        }
      </style>

      <div class="mf-wrap">
        <div class="mf-title">Manufacturing Dashboard</div>
        <div class="mf-subtitle">Full active assembly list, recursive BOM explosion, and availability / shortage status.</div>

        <div class="kpi-grid">
          ${kpiCard('Active Assemblies', dashboard.totalAssemblies, 'Assembly/BOM items currently active', 'blue')}
          ${kpiCard('Missing BOM', dashboard.missingBomCount, missingBomPct + '% of active assemblies', dashboard.missingBomCount > 0 ? 'red' : 'green')}
          ${kpiCard('With Components', dashboard.assembliesWithComponents, 'Assemblies with at least one member item', 'green')}
          ${kpiCard('Placeholder Usage', dashboard.placeholderComponents.length, 'Top temporary/dummy component hits', dashboard.placeholderComponents.length > 0 ? 'yellow' : 'green')}
          ${kpiCard('Inactive Assemblies', dashboard.inactiveAssemblies, 'Inactive assembly item count', 'yellow')}
        </div>

        <div id="bomInsightsCard" class="collapsible-card collapsed">
          <button type="button" class="collapsible-header" onclick="toggleBomInsights(); return false;">
            <span class="collapsible-title">
              <span id="bomInsightsIcon" class="collapse-icon">+</span>
              <span>BOM Insights</span>
            </span>
            <span class="collapsible-note">Largest BOMs and placeholder component usage</span>
          </button>

          <div class="collapsible-body">
            <div class="dashboard-grid">
              ${riskPanel('Largest BOMs', dashboard.topLargeBoms, 'count')}
              ${riskPanel('Placeholder Components', dashboard.placeholderComponents, 'component')}
            </div>
          </div>
        </div>

        <div class="mode-tabs">
          <button type="button" class="tab ${mode === 'list' ? 'active' : ''}" onclick="goListMode()">Full Assembly List</button>
          <button type="button" class="tab ${mode === 'explode' ? 'active' : ''}" onclick="goExplodeMode()">Recursive BOM Explosion</button>
        </div>

        <div class="search-card">
          <div class="search-row">
            <input
              id="assemblySearch"
              class="search-input"
              type="text"
              placeholder="${mode === 'explode' ? 'Enter top assembly, e.g. 830-0248-00' : 'Search assembly list, e.g. 830-0248-00'}"
              value="${escapeHtml(assemblyFilter)}"
              onkeydown="if(event.key === 'Enter'){runSearch();}"
            />
            <button type="button" class="btn btn-primary" onclick="runSearch()">
              ${mode === 'explode' ? 'Explode BOM' : 'Search List'}
            </button>
            <button type="button" class="btn btn-muted" onclick="clearSearch()">Clear</button>
          </div>
        </div>

        ${errorMessage ? '<div class="error">' + escapeHtml(errorMessage) + '</div>' : ''}

        ${
          mode === 'explode'
            ? buildExplosionHtml(explosionData)
            : buildFullListHtml(listData, pageIndex)
        }
      </div>

      <script>
        var suiteletUrl = '${escapeJs(scriptUrl)}';
        var currentMode = '${escapeJs(mode)}';

        function toggleBomInsights() {
          var card = document.getElementById('bomInsightsCard');
          var icon = document.getElementById('bomInsightsIcon');

          if (!card || !icon) {
            return false;
          }

          var isCollapsed = card.className.indexOf('collapsed') !== -1;

          if (isCollapsed) {
            card.className = card.className.replace(' collapsed', '').replace('collapsed', '');
            icon.innerHTML = '-';
          } else {
            card.className = card.className + ' collapsed';
            icon.innerHTML = '+';
          }

          return false;
        }

        function toggleAssembly(parentId, row) {
          var rows = document.querySelectorAll('.child-' + parentId);
          var icon = document.getElementById('icon_' + parentId);
          var isOpen = row.classList.contains('open');

          rows.forEach(function(childRow) {
            childRow.style.display = isOpen ? 'none' : 'table-row';
          });

          row.classList.toggle('open', !isOpen);

          if (icon) {
            icon.textContent = isOpen ? '+' : '-';
          }
        }

        function runSearch() {
          var value = document.getElementById('assemblySearch').value || '';
          window.location.href = suiteletUrl + '&mode=' + currentMode + '&page=0&assembly=' + encodeURIComponent(value);
        }

        function clearSearch() {
          window.location.href = suiteletUrl + '&mode=' + currentMode + '&page=0';
        }

        function goPage(page) {
          var value = document.getElementById('assemblySearch').value || '';
          window.location.href = suiteletUrl + '&mode=list&page=' + page + '&assembly=' + encodeURIComponent(value);
        }

        function goListMode() {
          window.location.href = suiteletUrl + '&mode=list&page=0';
        }

        function goExplodeMode() {
          var value = document.getElementById('assemblySearch').value || '';
          window.location.href = suiteletUrl + '&mode=explode&assembly=' + encodeURIComponent(value);
        }
      </script>
    `;
  };

  const buildFullListHtml = (listData, pageIndex) => {
    const rows = listData.assemblies.map((assembly, index) => {
      const parentId = 'asm_' + index;

      const componentRows = assembly.components.map((component) => {
        const statusClass =
          component.status === 'SHORTAGE'
            ? 'status-shortage'
            : component.status === 'LOW'
              ? 'status-low'
              : 'status-ok';

        const statusIcon =
          component.status === 'SHORTAGE'
            ? 'RED'
            : component.status === 'LOW'
              ? 'LOW'
              : 'OK';

        return `
          <tr class="component-row child-${parentId}" style="display:none;">
            <td></td>
            <td class="component-cell">
              <span class="tree-line"></span>
              <span class="component-badge">${component.isAssembly ? 'Sub Assembly' : 'Component'}</span>
              <span class="component-name">${escapeHtml(component.item)}</span>
            </td>
            <td>${escapeHtml(component.description)}</td>
            <td class="qty">${escapeHtml(formatQty(component.quantity))}</td>
            <td class="qty">${escapeHtml(formatQty(component.availableQty))}</td>
            <td>${escapeHtml(component.units)}</td>
            <td><span class="status ${statusClass}">${escapeHtml(statusIcon)} ${escapeHtml(component.status)}</span></td>
          </tr>
        `;
      }).join('');

      return `
        <tr class="assembly-row" onclick="toggleAssembly('${parentId}', this)">
          <td class="expand-cell">
            <span class="expand-icon" id="icon_${parentId}">+</span>
          </td>
          <td>
            <span class="assembly-name">${escapeHtml(assembly.name)}</span>
            <div class="assembly-desc">${escapeHtml(assembly.description)}</div>
          </td>
          <td>
            <span class="count-pill">${assembly.components.length} components</span>
          </td>
          <td></td>
          <td></td>
          <td></td>
          <td></td>
        </tr>
        ${
          assembly.components.length > 0
            ? componentRows
            : `<tr class="component-row child-${parentId}" style="display:none;">
                <td></td>
                <td class="component-cell"><span class="tree-line"></span><span class="component-badge">No BOM</span></td>
                <td colspan="5">No component rows found.</td>
              </tr>`
        }
      `;
    }).join('');

    return `
      <div class="stats-row">
        <div class="stat">Total matching assemblies: ${listData.totalCount}</div>
        <div class="stat">Page: ${pageIndex + 1} of ${Math.max(listData.pageCount, 1)}</div>
        <div class="stat">Page size: ${PAGE_SIZE}</div>
      </div>

      <div class="table-card">
        <table class="bom-table">
          <thead>
            <tr>
              <th></th>
              <th>Assembly / Component</th>
              <th>Description</th>
              <th>Required</th>
              <th>Available</th>
              <th>Units</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${
              listData.assemblies.length > 0
                ? rows
                : '<tr><td colspan="7" style="padding:28px;text-align:center;color:#64748b;font-weight:900;">No assemblies found.</td></tr>'
            }
          </tbody>
        </table>
      </div>

      <div class="pager">
        <div class="mf-subtitle">Full active assembly list with level-1 BOM components.</div>
        <div>
          <button
            type="button"
            class="btn btn-muted ${pageIndex > 0 ? '' : 'btn-disabled'}"
            ${pageIndex > 0 ? 'onclick="goPage(' + (pageIndex - 1) + ')"' : 'disabled'}
          >
            Previous 100
          </button>
          <button
            type="button"
            class="btn btn-primary ${listData.hasNextPage ? '' : 'btn-disabled'}"
            ${listData.hasNextPage ? 'onclick="goPage(' + (pageIndex + 1) + ')"' : 'disabled'}
          >
            Next 100
          </button>
        </div>
      </div>
    `;
  };

  const buildExplosionHtml = (data) => {
    if (!data) {
      return '<div class="table-card" style="padding:28px;text-align:center;color:#64748b;font-weight:900;">Enter a top assembly item number to generate the recursive BOM explosion.</div>';
    }

    return `
      <div class="kpi-grid">
        ${kpiCard('Top Assembly', data.root.item, data.root.description, 'blue')}
        ${kpiCard('Total BOM Lines', data.summary.totalComponents, 'Recursive component lines', 'blue')}
        ${kpiCard('Shortages', data.summary.shortageCount, 'Components below required quantity', data.summary.shortageCount > 0 ? 'red' : 'green')}
        ${kpiCard('Low Stock', data.summary.lowCount, 'Available but close to required qty', data.summary.lowCount > 0 ? 'yellow' : 'green')}
        ${kpiCard('Max BOM Depth', data.summary.maxDepth, 'Levels below top assembly', 'yellow')}
      </div>

      <div class="table-card">
        <div class="tree-header">
          <div>Assembly / Component</div>
          <div>Description</div>
          <div>Required</div>
          <div>Available</div>
          <div>On Order</div>
          <div>Status</div>
        </div>
        ${buildTreeNodeHtml(data.root, true)}
      </div>
    `;
  };

  const buildTreeNodeHtml = (node, isRoot) => {
    const rowClass = isRoot ? 'root' : node.isAssembly ? 'assembly' : 'component';

    const statusClass =
      node.status === 'SHORTAGE'
        ? 'status-shortage'
        : node.status === 'LOW'
          ? 'status-low'
          : 'status-ok';

    const statusIcon =
      node.status === 'SHORTAGE'
        ? 'RED'
        : node.status === 'LOW'
          ? 'LOW'
          : 'OK';

    const indentPx = node.level * 28;
    const branch = isRoot ? '' : '|--';

    let html = `
      <div class="tree-row ${rowClass}">
        <div>
          <span class="tree-indent" style="width:${indentPx}px;"></span>
          <span class="tree-branch">${branch}</span>
          <span class="component-name">${escapeHtml(node.item)}</span>
          <span class="${node.isAssembly ? 'assembly-badge' : 'component-badge'}">
            ${node.isAssembly ? (isRoot ? 'Top Assembly' : 'Sub Assembly') : 'Component'}
          </span>
          <div class="assembly-desc" style="margin-left:${indentPx + 34}px;">
            ${escapeHtml(node.units ? 'UOM: ' + node.units : '')}
          </div>
        </div>
        <div>${escapeHtml(node.description)}</div>
        <div class="qty">${escapeHtml(formatQty(node.requiredQty))}</div>
        <div class="qty">${escapeHtml(formatQty(node.availableQty))}</div>
        <div class="qty">${escapeHtml(formatQty(node.onOrderQty))}</div>
        <div><span class="status ${statusClass}">${escapeHtml(statusIcon)} ${escapeHtml(node.status)}</span></div>
      </div>
    `;

    node.children.forEach((child) => {
      html += buildTreeNodeHtml(child, false);
    });

    return html;
  };

  const kpiCard = (label, value, note, cls) => `
    <div class="kpi-card ${cls}">
      <div class="kpi-label">${escapeHtml(label)}</div>
      <div class="kpi-value" style="font-size:${String(value).length > 12 ? '20px' : '30px'};">
        ${escapeHtml(value)}
      </div>
      <div class="kpi-note">${escapeHtml(note)}</div>
    </div>
  `;

  const riskPanel = (title, rows, mode) => `
    <div class="panel">
      <div class="panel-header">${escapeHtml(title)}</div>
      <div class="panel-body">
        <table class="mini-table">
          ${
            rows.length
              ? rows.map((r) => `
                  <tr>
                    <td>
                      <div class="mini-main">${escapeHtml(r.assembly || '')}</div>
                      <div class="mini-sub">${escapeHtml(r.description || r.assemblyDescription || '')}</div>
                    </td>
                    <td style="text-align:right;font-weight:900;">
                      ${
                        mode === 'count'
                          ? escapeHtml(r.count)
                          : '<div class="mini-main">' + escapeHtml(r.component || '') + '</div><div class="mini-sub">' + escapeHtml(r.componentDescription || '') + '</div>'
                      }
                    </td>
                  </tr>
                `).join('')
              : '<tr><td style="color:#64748b;font-weight:900;">No issues found.</td></tr>'
          }
        </table>
      </div>
    </div>
  `;

  const formatQty = (value) => {
    const n = parseNumber(value);
    if (Math.abs(n - Math.round(n)) < 0.00001) return String(Math.round(n));
    return String(roundQty(n));
  };

  const escapeHtml = (value) => {
    if (value === null || value === undefined) return '';

    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };

  const escapeJs = (value) => {
    if (value === null || value === undefined) return '';

    return String(value)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\r/g, '')
      .replace(/\n/g, '');
  };

  return { onRequest };
});
