const handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            },
            body: ''
        };
    }

    const params = event.queryStringParameters || {};
    const username = params.username;
    const year = params.year;

    if (!username) {
        return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ error: 'username parameter is required' })
        };
    }

    let url = 'https://github.com/users/' + encodeURIComponent(username) + '/contributions';
    if (year && year !== 'last') {
        url += '?from=' + year + '-01-01&to=' + year + '-12-31';
    }

    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://github.com/' + encodeURIComponent(username),
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'same-origin'
            }
        });

        if (!res.ok) {
            return {
                statusCode: res.status,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
                body: JSON.stringify({ error: 'GitHub returned HTTP ' + res.status, contributions: {} })
            };
        }

        const html = await res.text();
        const contributions = {};
        let parseMethod = 'none';
        let match;

        // STRATEGY 1: data-date then data-level in same tag
        const tagRegex1 = /<(?:td|rect)[^>]*?\bdata-date="(\d{4}-\d{2}-\d{2})"[^>]*?\bdata-level="(\d)"[^>]*?>/gi;
        while ((match = tagRegex1.exec(html)) !== null) {
            const date = match[1];
            const level = parseInt(match[2], 10);
            const fullTag = match[0];
            let count = 0;
            const ariaMatch = fullTag.match(/aria-label="(\d+)\s+contribution/i);
            if (ariaMatch) count = parseInt(ariaMatch[1], 10);
            if (/aria-label="No\s+contribution/i.test(fullTag)) count = 0;
            if (count === 0 && level > 0) {
                const dcMatch = fullTag.match(/data-count="(\d+)"/);
                if (dcMatch) count = parseInt(dcMatch[1], 10);
            }
            contributions[date] = { level: level, count: count };
        }
        if (Object.keys(contributions).length > 0) parseMethod = 'data-date-forward';

        // STRATEGY 2: data-level then data-date (reversed)
        if (Object.keys(contributions).length === 0) {
            const tagRegex2 = /<(?:td|rect)[^>]*?\bdata-level="(\d)"[^>]*?\bdata-date="(\d{4}-\d{2}-\d{2})"[^>]*?>/gi;
            while ((match = tagRegex2.exec(html)) !== null) {
                const level = parseInt(match[1], 10);
                const date = match[2];
                const fullTag = match[0];
                let count = 0;
                const ariaMatch = fullTag.match(/aria-label="(\d+)\s+contribution/i);
                if (ariaMatch) count = parseInt(ariaMatch[1], 10);
                if (count === 0 && level > 0) {
                    const dcMatch = fullTag.match(/data-count="(\d+)"/);
                    if (dcMatch) count = parseInt(dcMatch[1], 10);
                }
                contributions[date] = { level: level, count: count };
            }
            if (Object.keys(contributions).length > 0) parseMethod = 'data-date-reverse';
        }

        // STRATEGY 3: Find all data-date, reconstruct full tag to get level
        if (Object.keys(contributions).length === 0) {
            const allDatePositions = [];
            const simpleDateRegex = /data-date="(\d{4}-\d{2}-\d{2})"/g;
            while ((match = simpleDateRegex.exec(html)) !== null) {
                allDatePositions.push({ date: match[1], index: match.index });
            }
            for (var pi = 0; pi < allDatePositions.length; pi++) {
                var pos = allDatePositions[pi];
                var tagStart = html.lastIndexOf('<', pos.index);
                var tagEnd = html.indexOf('>', pos.index);
                if (tagStart === -1 || tagEnd === -1) continue;
                var fullTag = html.substring(tagStart, tagEnd + 1);
                var levelMatch = fullTag.match(/data-level="(\d)"/);
                var level = levelMatch ? parseInt(levelMatch[1], 10) : 0;
                var count = 0;
                var ariaMatch = fullTag.match(/aria-label="(\d+)\s+contribution/i);
                if (ariaMatch) count = parseInt(ariaMatch[1], 10);
                var dcMatch = fullTag.match(/data-count="(\d+)"/);
                if (count === 0 && dcMatch) count = parseInt(dcMatch[1], 10);
                if (count === 0 && level > 0) {
                    var estimates = [0, 2, 5, 8, 12];
                    count = estimates[level] || 0;
                }
                contributions[pos.date] = { level: level, count: count };
            }
            if (Object.keys(contributions).length > 0) parseMethod = 'tag-reconstruction';
        }

        // STRATEGY 4: aria-label with full date text
        if (Object.keys(contributions).length === 0) {
            var monthMap = {
                'january': '01', 'february': '02', 'march': '03', 'april': '04',
                'may': '05', 'june': '06', 'july': '07', 'august': '08',
                'september': '09', 'october': '10', 'november': '11', 'december': '12'
            };
            var ariaRegex = /aria-label="(\d+)\s+contributions?\s+on\s+(\w+)\s+(\d{1,2}),?\s+(\d{4})"/gi;
            while ((match = ariaRegex.exec(html)) !== null) {
                var cnt = parseInt(match[1], 10);
                var mn = match[2].toLowerCase();
                var dy = match[3].padStart(2, '0');
                var yr = match[4];
                var mo = monthMap[mn];
                if (mo) {
                    var dt = yr + '-' + mo + '-' + dy;
                    var lv = 0;
                    if (cnt >= 1 && cnt <= 3) lv = 1;
                    else if (cnt >= 4 && cnt <= 6) lv = 2;
                    else if (cnt >= 7 && cnt <= 9) lv = 3;
                    else if (cnt >= 10) lv = 4;
                    contributions[dt] = { level: lv, count: cnt };
                }
            }
            var noAriaRegex = /aria-label="No\s+contributions?\s+on\s+(\w+)\s+(\d{1,2}),?\s+(\d{4})"/gi;
            while ((match = noAriaRegex.exec(html)) !== null) {
                var mn2 = match[1].toLowerCase();
                var dy2 = match[2].padStart(2, '0');
                var yr2 = match[3];
                var mo2 = monthMap[mn2];
                if (mo2) {
                    contributions[yr2 + '-' + mo2 + '-' + dy2] = { level: 0, count: 0 };
                }
            }
            if (Object.keys(contributions).length > 0) parseMethod = 'aria-label';
        }

        // STRATEGY 5: tooltip text anywhere in HTML
        if (Object.keys(contributions).length === 0) {
            var monthMap2 = {
                'january': '01', 'february': '02', 'march': '03', 'april': '04',
                'may': '05', 'june': '06', 'july': '07', 'august': '08',
                'september': '09', 'october': '10', 'november': '11', 'december': '12'
            };
            var tipRegex = /(\d+)\s+contributions?\s+on\s+(\w+)\s+(\d{1,2}),?\s+(\d{4})/gi;
            while ((match = tipRegex.exec(html)) !== null) {
                var cnt2 = parseInt(match[1], 10);
                var mn3 = match[2].toLowerCase();
                var dy3 = match[3].padStart(2, '0');
                var yr3 = match[4];
                var mo3 = monthMap2[mn3];
                if (mo3) {
                    var dt2 = yr3 + '-' + mo3 + '-' + dy3;
                    var lv2 = 0;
                    if (cnt2 >= 1 && cnt2 <= 3) lv2 = 1;
                    else if (cnt2 >= 4 && cnt2 <= 6) lv2 = 2;
                    else if (cnt2 >= 7 && cnt2 <= 9) lv2 = 3;
                    else if (cnt2 >= 10) lv2 = 4;
                    contributions[dt2] = { level: lv2, count: cnt2 };
                }
            }
            var noTipRegex = /No\s+contributions?\s+on\s+(\w+)\s+(\d{1,2}),?\s+(\d{4})/gi;
            while ((match = noTipRegex.exec(html)) !== null) {
                var mn4 = match[1].toLowerCase();
                var dy4 = match[2].padStart(2, '0');
                var yr4 = match[3];
                var mo4 = monthMap2[mn4];
                if (mo4) {
                    var dt3 = yr4 + '-' + mo4 + '-' + dy4;
                    if (!contributions[dt3]) {
                        contributions[dt3] = { level: 0, count: 0 };
                    }
                }
            }
            if (Object.keys(contributions).length > 0) parseMethod = 'tooltip-text';
        }

        // STRATEGY 6: SVG rect elements (old format)
        if (Object.keys(contributions).length === 0) {
            var rectRegex = /<rect[^>]+>/gi;
            while ((match = rectRegex.exec(html)) !== null) {
                var rect = match[0];
                var dateMatch = rect.match(/data-date="(\d{4}-\d{2}-\d{2})"/);
                if (!dateMatch) continue;
                var rDate = dateMatch[1];
                var rLevelMatch = rect.match(/data-level="(\d)"/);
                var rCountMatch = rect.match(/data-count="(\d+)"/);
                contributions[rDate] = {
                    level: rLevelMatch ? parseInt(rLevelMatch[1], 10) : 0,
                    count: rCountMatch ? parseInt(rCountMatch[1], 10) : 0
                };
            }
            if (Object.keys(contributions).length > 0) parseMethod = 'svg-rect';
        }

        // Calculate total
        var totalContributions = 0;
        var allKeys = Object.keys(contributions);
        for (var ki = 0; ki < allKeys.length; ki++) {
            totalContributions += contributions[allKeys[ki]].count || 0;
        }

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Cache-Control': 'public, max-age=1800'
            },
            body: JSON.stringify({
                contributions: contributions,
                meta: {
                    username: username,
                    year: year || 'last',
                    totalDays: allKeys.length,
                    totalContributions: totalContributions,
                    parseMethod: parseMethod,
                    fetchedAt: new Date().toISOString()
                }
            })
        };
    } catch (err) {
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ error: err.message, contributions: {} })
        };
    }
};

module.exports = { handler: handler };