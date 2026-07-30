/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(
    ['N/render', 'N/record', 'N/search', 'N/runtime', 'N/format'],
    (render, record, search, runtime, format) => {

    const TEMPLATE_INTERNAL_ID = 209;

    const normalizeText = (value) => {
        if (value === null || value === undefined) {
            return '';
        }
        return String(value)
            .replace(/&nbsp;/gi, '')
            .replace(/\u00a0/g, ' ')
            .trim();
    };

    const getBodyText = (workOrder, fieldId) => {
        try {
            return normalizeText(workOrder.getText({ fieldId }));
        } catch (error) {
            return normalizeText(workOrder.getValue({ fieldId }));
        }
    };

    const getLineText = (workOrder, fieldId, line) => {
        try {
            return workOrder.getSublistText({
                sublistId: 'item',
                fieldId,
                line
            }) || '';
        } catch (error) {
            return workOrder.getSublistValue({
                sublistId: 'item',
                fieldId,
                line
            }) || '';
        }
    };

    const formatQuantity = (value) => {
        const quantity = Number(value) || 0;
        return Number.isInteger(quantity)
            ? String(quantity)
            : String(Number(quantity.toFixed(5)));
    };

    const getItemInfo = (itemId, itemCache) => {
        if (!itemId) {
            return {};
        }

        if (itemCache[itemId]) {
            return itemCache[itemId];
        }

        try {
            const itemInfo = search.lookupFields({
                type: search.Type.ITEM,
                id: itemId,
                columns: [
                    'itemid',
                    'displayname',
                    'salesdescription'
                ]
            });

            itemCache[itemId] = {
                itemCode: itemInfo.itemid || '',
                displayName: itemInfo.displayname || '',
                salesDescription: itemInfo.salesdescription || ''
            };
        } catch (error) {
            log.error({
                title: `Item lookup failed for item ${itemId}`,
                details: error
            });
            itemCache[itemId] = {};
        }

        return itemCache[itemId];
    };

    const getInventoryBalance = (itemId, locationId) => {
        if (!itemId) {
            return [];
        }

        try {
            const filters = [
                ['item', 'anyof', itemId],
                'AND',
                ['available', 'greaterthan', '0']
            ];

            if (locationId) {
                filters.push('AND', ['location', 'anyof', locationId]);
            }

            const results = search.create({
                type: search.Type.INVENTORY_BALANCE,
                filters,
                columns: [
                    search.createColumn({
                        name: 'binnumber',
                        sort: search.Sort.ASC
                    }),
                    search.createColumn({ name: 'available' })
                ]
            }).run().getRange({
                start: 0,
                end: 100
            }) || [];

            const balancesByBin = {};

            results.forEach((result) => {
                const bin =
                    result.getText({ name: 'binnumber' }) ||
                    result.getValue({ name: 'binnumber' }) ||
                    'Unbinned';

                const available =
                    Number(result.getValue({ name: 'available' })) || 0;

                balancesByBin[bin] =
                    (balancesByBin[bin] || 0) + available;
            });

            return Object.keys(balancesByBin).map((bin) => ({
                bin,
                quantity: formatQuantity(balancesByBin[bin])
            }));

        } catch (error) {
            log.error({
                title: `Inventory balance lookup failed for item ${itemId}`,
                details: error
            });
            return [];
        }
    };

    const buildBomLines = (workOrder) => {
        const lineCount = workOrder.getLineCount({
            sublistId: 'item'
        });

        const bodyLocation = workOrder.getValue({
            fieldId: 'location'
        });

        const lines = [];
        const inventoryCache = {};
        const itemCache = {};

        for (let line = 0; line < lineCount; line += 1) {
            const itemId = workOrder.getSublistValue({
                sublistId: 'item',
                fieldId: 'item',
                line
            });

            const lineLocation = workOrder.getSublistValue({
                sublistId: 'item',
                fieldId: 'location',
                line
            }) || bodyLocation;

            const cacheKey = `${itemId}:${lineLocation || ''}`;

            if (inventoryCache[cacheKey] === undefined) {
                inventoryCache[cacheKey] =
                    getInventoryBalance(itemId, lineLocation);
            }

            const itemInfo = getItemInfo(itemId, itemCache);
            const lineDescription = workOrder.getSublistValue({
                sublistId: 'item',
                fieldId: 'description',
                line
            }) || '';

            lines.push({
                item:
                    itemInfo.itemCode ||
                    getLineText(workOrder, 'item', line),
                quantity: workOrder.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    line
                }) || '',
                units: getLineText(workOrder, 'units', line),
                inventoryDetails: inventoryCache[cacheKey],
                description:
                    lineDescription ||
                    itemInfo.salesDescription ||
                    itemInfo.displayName ||
                    ''
            });
        }

        return lines;
    };

    const buildHeaderData = (workOrder) => {
        const itemCache = {};
        const assemblyItemId = workOrder.getValue({
            fieldId: 'assemblyitem'
        });
        const assemblyInfo = getItemInfo(assemblyItemId, itemCache);

        return {
            assemblyDescription:
                assemblyInfo.salesDescription ||
                assemblyInfo.displayName ||
                '',
            className: getBodyText(workOrder, 'class'),
            customer: getBodyText(workOrder, 'entity'),
            revision: getBodyText(workOrder, 'revision'),
            location: getBodyText(workOrder, 'location'),
            subsidiary: getBodyText(workOrder, 'subsidiary'),
            status: getBodyText(workOrder, 'status')
        };
    };

    const onRequest = (context) => {
        try {
            const suppliedId =
                context.request.parameters.woid ||
                context.request.parameters.id;

            const workOrderId = Number(suppliedId);

            if (!suppliedId || !Number.isInteger(workOrderId)) {
                throw new Error(
                    'A valid Work Order internal ID was not provided.'
                );
            }

            const workOrder = record.load({
                type: record.Type.WORK_ORDER,
                id: workOrderId,
                isDynamic: false
            });

            const renderer = render.create();

            renderer.setTemplateById({
                id: TEMPLATE_INTERNAL_ID
            });

            renderer.addRecord({
                templateName: 'record',
                record: workOrder
            });

            renderer.addCustomDataSource({
                format: render.DataSource.OBJECT,
                alias: 'bom',
                data: {
                    lines: buildBomLines(workOrder),
                    header: buildHeaderData(workOrder),
                    printedAt: format.format({
                        value: new Date(),
                        type: format.Type.DATETIMETZ
                    }),
                    printedBy: runtime.getCurrentUser().name || ''
                }
            });

            const pdfFile = renderer.renderAsPdf();

            const transactionNumber =
                workOrder.getValue({ fieldId: 'tranid' }) ||
                workOrderId;

            pdfFile.name = `PSiQ_BOM_${transactionNumber}.pdf`;

            context.response.writeFile({
                file: pdfFile,
                isInline: true
            });

        } catch (error) {
            log.error({
                title: 'PSiQ BOM Printing Error',
                details: {
                    name: error.name,
                    message: error.message,
                    stack: error.stack
                }
            });

            context.response.write({
                output:
                    'Unable to generate PSiQ BOM PDF: ' +
                    `${error.name || 'ERROR'} - ${error.message}`
            });
        }
    };

    return { onRequest };
    }
);
