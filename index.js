import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 30001;

// 設置靜態文件服務
app.use(express.static(path.join(__dirname, 'public')));

// Bilibili API 需要模擬瀏覽器請求，因此設定固定的 Headers
const BILI_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com/',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site'
};

// 函數：從 URL 中提取 bvid
function getBvidFromURL(url) {
    // 支持多種 B站 URL 格式
    let match = url.match(/(?=BV).*?(?=\?|\/|$)/);
    if (match) return match[0];
    
    match = url.match(/bvid=(BV[a-zA-Z0-9]+)/);
    if (match) return match[1];
    
    match = url.match(/\/video\/(BV[a-zA-Z0-9]+)/);
    if (match) return match[1];
    
    return null;
}

// 函數：格式化時長
function formatDuration(seconds) {
    if (!seconds) return '未知';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
        return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }
}

// 函數：獲取畫質描述
function getQualityDescription(qn) {
    const qualityMap = {
        120: '4K 超清',
        116: '1080P60 高幀率',
        112: '1080P+ 高碼率',
        80: '1080P 高清',
        74: '720P60 高幀率', 
        64: '720P 高清',
        32: '480P 清晰',
        16: '360P 流暢'
    };
    return qualityMap[qn] || `${qn}P`;
}

// API 路由：解析影片
app.get('/api/parse', async (req, res) => {
    const biliURL = req.query.url;

    if (!biliURL) {
        return res.status(400).json({ error: '請提供 url 參數' });
    }

    const bvid = getBvidFromURL(biliURL);
    if (!bvid) {
        return res.status(400).json({ error: '無法從您提供的 URL 中找到有效的 BVID' });
    }

    console.log(`正在解析 BVID: ${bvid}`);

    try {
        // 第一步：獲取影片頁面資訊，包含 cid 列表
        const pageListUrl = `https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`;
        const pageListResponse = await fetch(pageListUrl, { headers: BILI_HEADERS });
        const pageListData = await pageListResponse.json();

        if (pageListData.code !== 0 || !pageListData.data || pageListData.data.length === 0) {
            return res.status(500).json({ error: '獲取影片信息失敗', message: pageListData.message || '影片不存在或已被刪除' });
        }

        const cid = pageListData.data[0].cid; // 獲取第一個分P的 cid
        console.log(`獲取到 CID: ${cid}`);

        // 第二步：獲取影片基本信息
        const viewUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
        const viewResponse = await fetch(viewUrl, { headers: BILI_HEADERS });
        const viewData = await viewResponse.json();

        let videoInfo = {
            title: '未知標題',
            duration: 0,
            quality: '未知'
        };

        if (viewData.code === 0 && viewData.data) {
            videoInfo.title = viewData.data.title;
            videoInfo.duration = viewData.data.duration;
        }

        // 第三步：獲取播放地址，使用高畫質參數
        const playUrlApiUrl = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=116&type=&otype=json&platform=html5&high_quality=1`;
        const playUrlResponse = await fetch(playUrlApiUrl, { 
            headers: { 
                ...BILI_HEADERS, 
                'Referer': biliURL 
            } 
        });
        const playUrlData = await playUrlResponse.json();

        if (playUrlData.code !== 0) {
            return res.status(500).json({ error: '獲取播放網址失敗', message: playUrlData.message || '可能需要登錄或該影片有訪問限制' });
        }

        // 第四步：提取 CDN 網址
        let cdnURL = null;
        let quality = '未知';

        // 優先嘗試 durl 格式（FLV/MP4）
        if (playUrlData.data && playUrlData.data.durl && playUrlData.data.durl.length > 0) {
            cdnURL = playUrlData.data.durl[0].url;
            quality = getQualityDescription(playUrlData.data.quality || 80);
        }
        // 備用：嘗試 DASH 格式
        else if (playUrlData.data && playUrlData.data.dash && playUrlData.data.dash.video && playUrlData.data.dash.video.length > 0) {
            cdnURL = playUrlData.data.dash.video[0].baseUrl;
            quality = getQualityDescription(playUrlData.data.dash.video[0].id || 80);
        }

        if (!cdnURL) {
            return res.status(404).json({ error: '未找到可用的影片 CDN 網址' });
        }

        console.log(`解析成功，回傳 CDN 網址: ${cdnURL}`);

        // 返回完整的解析結果
        res.json({
            cdnUrl: cdnURL,
            title: videoInfo.title,
            duration: formatDuration(videoInfo.duration),
            quality: quality,
            bvid: bvid
        });

    } catch (error) {
        console.error('解析過程中發生錯誤:', error);
        return res.status(502).json({ error: '伺服器內部錯誤', message: error.message });
    }
});

// 根路由：返回主頁面
app.get('/', (req, res) => {
    // 如果有 url 參數，重定向到 API
    if (req.query.url) {
        return res.redirect(`/api/parse?url=${encodeURIComponent(req.query.url)}`);
    }
    
    // 否則返回 HTML 頁面
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// 啟動伺服器
app.listen(PORT, () => {
    console.log(`伺服器已啟動，請訪問 http://localhost:${PORT}`);
});
