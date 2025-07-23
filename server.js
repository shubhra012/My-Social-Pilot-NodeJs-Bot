// server.js

// --- Imports ---
require('dotenv').config();
const { TwitterApi } = require('twitter-api-v2');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// --- Initialization ---
const app = express();
const port = 3000;
const CACHE_FILE_PATH = './cache.json';
const FOLLOWER_HISTORY_PATH = './follower_history.json';

// --- Twitter Client ---
const twitterClient = new TwitterApi({
    appKey: process.env.TWITTER_API_KEY,
    appSecret: process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
});

// --- Telegram Bot ---
const telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
console.log("Telegram Bot initialized.");

// --- In-Memory Storage & Cache ---
let scheduledPosts = [];
let statsCache = null;

// --- Default Data Structure ---
const getDefaultStatsData = () => ({
    followers: 'N/A', likes: 'N/A', comments: 'N/A', scheduledPosts: scheduledPosts.length,
    activity: [{ action: "Waiting for first successful connection to Twitter...", timestamp: new Date() }],
    rawFollowers: 0, rawTimeline: []
});

// --- Cache Functions ---
const loadCache = () => {
    try {
        if (fs.existsSync(CACHE_FILE_PATH)) {
            const cacheData = fs.readFileSync(CACHE_FILE_PATH, 'utf-8');
            const parsedCache = JSON.parse(cacheData);
            if (parsedCache && parsedCache.data && parsedCache.timestamp) {
                statsCache = parsedCache;
                console.log("Persistent cache loaded from file.");
                return;
            }
        }
        console.log("No valid cache file found. Initializing with default data.");
        statsCache = { data: getDefaultStatsData(), timestamp: 0 };
    } catch (error) {
        console.error("Could not load cache file, initializing with default data:", error);
        statsCache = { data: getDefaultStatsData(), timestamp: 0 };
    }
};

const saveCache = () => {
    try {
        if (statsCache) {
            fs.writeFileSync(CACHE_FILE_PATH, JSON.stringify(statsCache));
            console.log("Cache saved to file.");
        }
    } catch (error) {
        console.error("Could not save cache to file:", error);
    }
};

// --- Background Worker for Twitter Data ---
const backgroundTwitterUpdater = async () => {
    console.log("[Twitter Worker] Checking if data needs refreshing...");
    const isCacheStale = !statsCache || !statsCache.timestamp || (Date.now() - statsCache.timestamp > 900000);
    if (!isCacheStale) return console.log("[Twitter Worker] Cache is fresh.");
    
    console.log("[Twitter Worker] Cache is stale. Fetching new data...");
    try {
        const me = await twitterClient.v2.me({ 'user.fields': ['public_metrics'] });
        const timeline = await twitterClient.v2.userTimeline(me.data.id, { 'tweet.fields': ['public_metrics', 'created_at'], 'max_results': 100 });
        let totalLikes = 0, totalComments = 0, formattedActivity = [];
        if (timeline.data.data) {
            for (const tweet of timeline.data.data) {
                totalLikes += tweet.public_metrics.like_count;
                totalComments += tweet.public_metrics.reply_count;
                formattedActivity.push({ action: `Posted: "${tweet.text}"`, timestamp: tweet.created_at });
            }
        }
        const newStatsData = { 
            followers: me.data.public_metrics.followers_count.toLocaleString(), 
            likes: totalLikes.toLocaleString(), 
            comments: totalComments.toLocaleString(),
            scheduledPosts: scheduledPosts.length,
            activity: formattedActivity,
            rawFollowers: me.data.public_metrics.followers_count,
            rawTimeline: timeline.data.data || []
        };
        statsCache = { data: newStatsData, timestamp: Date.now() };
        saveCache();
        console.log("[Twitter Worker] SUCCESS: Cache updated.");
    } catch (error) {
        console.error("[Twitter Worker] ERROR:", error.message);
    }
};

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- API ROUTES ---

// --- Twitter Routes ---
app.get('/api/twitter/stats', (req, res) => {
    console.log("Dashboard requested Twitter stats. Sending current cache.");
    res.json(statsCache.data);
});

app.get('/api/twitter/analytics', (req, res) => {
    console.log("Analytics page requested Twitter data. Calculating from cache.");
    if (!statsCache || !statsCache.data || statsCache.data.followers === 'N/A') {
        return res.status(503).json({ error: 'Analytics data is not available yet. Please wait for the background worker.' });
    }
    const { rawFollowers, rawTimeline } = statsCache.data;
    if (!rawTimeline || rawTimeline.length === 0) {
        return res.json({ topPost: { text: "No tweets found to analyze.", likes: 0, comments: 0 }, engagementRate: "0.00%", followerGrowth: "0.00%" });
    }
    let topPost = null, maxScore = -1, totalEngagements = 0;
    for (const tweet of rawTimeline) {
        const { like_count, reply_count, retweet_count } = tweet.public_metrics;
        totalEngagements += like_count + reply_count + retweet_count;
        const score = like_count + (reply_count * 2) + retweet_count;
        if (score > maxScore) {
            maxScore = score;
            topPost = { text: tweet.text, likes: like_count, comments: reply_count };
        }
    }
    const engagementRate = rawFollowers > 0 ? ((totalEngagements / rawTimeline.length) / rawFollowers * 100).toFixed(2) + '%' : "0.00%";
    let followerGrowth = "0.00%";
    try {
        if (fs.existsSync(FOLLOWER_HISTORY_PATH)) {
            const historyData = JSON.parse(fs.readFileSync(FOLLOWER_HISTORY_PATH));
            const previousFollowers = historyData.lastFollowerCount;
            if (previousFollowers > 0 && rawFollowers !== previousFollowers) {
                followerGrowth = `${((rawFollowers - previousFollowers) / previousFollowers * 100).toFixed(2)}%`;
            }
        }
        fs.writeFileSync(FOLLOWER_HISTORY_PATH, JSON.stringify({ lastFollowerCount: rawFollowers }));
    } catch (e) {
        console.error("Error with follower history:", e);
        followerGrowth = "N/A";
    }
    res.json({ topPost, engagementRate, followerGrowth });
});

// --- Telegram Routes ---
app.get('/api/telegram/stats', async (req, res) => {
    try {
        const chat = await telegramBot.getChat(process.env.TELEGRAM_CHANNEL_ID);
        const subscriberCount = await telegramBot.getChatMemberCount(process.env.TELEGRAM_CHANNEL_ID);
        res.json({
            followers: (subscriberCount - 1).toLocaleString(), // Subtract 1 for the bot itself
            likes: 'N/A',
            comments: 'N/A',
            scheduledPosts: scheduledPosts.filter(p => p.platform === 'Telegram').length,
            activity: [{ action: `Channel: ${chat.title}`, timestamp: new Date() }]
        });
    } catch (error) {
        console.error("Error fetching Telegram stats:", error.message);
        res.status(500).json({ error: "Could not fetch Telegram stats. Check your Channel ID." });
    }
});

app.get('/api/telegram/analytics', (req, res) => {
    res.json({ topPost: { text: "Analytics for Telegram are not yet supported." }, engagementRate: "N/A", followerGrowth: "N/A" });
});


// --- General Routes ---
app.post('/api/schedule', async (req, res) => {
    const { content, scheduleTime, platform } = req.body;
    if (!content || !scheduleTime || !platform) {
        return res.status(400).json({ error: 'Content, schedule time, and platform are required.' });
    }
    scheduledPosts.push({ id: Date.now(), platform, content, postAt: new Date(scheduleTime).getTime() });
    res.status(201).json({ message: `Post scheduled for ${platform} at ${new Date(scheduleTime).toLocaleString()}` });
});

app.post('/api/interact', async (req, res) => {
    const { type, keyword } = req.body;
    if (type !== 'Like') return res.status(400).json({ error: 'Only "Like" is supported.' });
    if (!keyword) return res.status(400).json({ error: 'A keyword is required.' });
    try {
        const searchResult = await twitterClient.v2.search(keyword, { 'max_results': 10 });
        if (!searchResult.data.data || searchResult.data.data.length === 0) return res.status(404).json({ message: `No recent tweets found with keyword: "${keyword}"` });
        const tweetId = searchResult.data.data[0].id;
        const me = await twitterClient.v2.me();
        await twitterClient.v2.like(me.data.id, tweetId);
        if (statsCache) { statsCache.timestamp = 0; saveCache(); }
        res.status(200).json({ message: `Successfully liked a tweet with keyword: "${keyword}"` });
    } catch (error) {
        console.error("Error performing like interaction:", error);
        res.status(500).json({ error: 'Could not perform like interaction.' });
    }
});

app.get('/api/trends', async (req, res) => res.json([{ hashtag: '#NodeJS', volume: '150K posts' }]));
app.get('/api/posts', (req, res) => res.json(scheduledPosts));

// --- CATCH-ALL ROUTE ---
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// --- SCHEDULER ---
setInterval(async () => {
    const now = Date.now();
    const postsToSend = scheduledPosts.filter(p => p.postAt <= now);
    if (postsToSend.length > 0) {
        for (const post of postsToSend) {
            try {
                if (post.platform === 'Twitter') {
                    console.log(`Posting to Twitter: "${post.content}"`);
                    await twitterClient.v2.tweet(post.content);
                } else if (post.platform === 'Telegram') {
                    console.log(`Posting to Telegram: "${post.content}"`);
                    await telegramBot.sendMessage(process.env.TELEGRAM_CHANNEL_ID, post.content);
                }
                scheduledPosts = scheduledPosts.filter(p => p.id !== post.id);
                if (statsCache) { statsCache.timestamp = 0; saveCache(); }
            } catch (error) {
                console.error(`Error posting scheduled message ID ${post.id}:`, error);
                scheduledPosts = scheduledPosts.filter(p => p.id !== post.id);
            }
        }
    }
}, 15000);

// --- Start Server ---
app.listen(port, () => {
    loadCache();
    backgroundTwitterUpdater();
    setInterval(backgroundTwitterUpdater, 905000);
    console.log(`Server is running! Access your dashboard at http://localhost:${port}`);
});
