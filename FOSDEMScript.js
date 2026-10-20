const PLATFORM = "FOSDEM";
const BASE_URL = "https://video.fosdem.org";
const SCHEDULE_BASE_URL = "https://fosdem.org";
const SEARCH_API_BASE_URL = "https://api.opensource-tv.com";
const CHANNEL_THUMBNAIL_URL = "https://plugins.grayjay.app/FOSDEM/FOSDEMIcon.png";
const EDITIONS_TTL_MS = 60 * 60 * 1000;
const EDITIONS_RETRY_MS = 60 * 1000; // Wait before requesting editions again after a failed or empty response
const LICENSE_NOTICE = "Content by FOSDEM (fosdem.org), licensed under CC-BY-2.0-BE.";
const CHANNEL_DESCRIPTION = `FOSDEM is a free event for software developers to meet, share ideas and collaborate. Every year, thousands of developers of free and open source software from all over the world gather at the event in Brussels.\n\n${LICENSE_NOTICE}`;

const REQUEST_HEADERS = {
    "User-Agent": `grayjay.app/${bridge.buildPlatform}/${bridge.buildVersion}`
};
const REQUEST_RETRIES = 2;
const RATE_LIMIT_WAIT_MS = 5000;

const ITEMS_PER_PAGE = 20;
const SUGGESTION_LIMIT = 10;
const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;
const IS_ANDROID = bridge.buildPlatform === "android";

// Talk filters shared by edition playlist URLs and search
const CATEGORY_FILTERS = ["track", "room", "type"];
const SEARCH_FILTERS = ["year", ...CATEGORY_FILTERS, "speaker"];

// Neither host defines this, but both accept the value
Type.Feed.Playlists = "Playlists";

/**
 * Matches talk pages on fosdem.org or archive.fosdem.org and captures the year and slug.
 * @example https://fosdem.org/2025/schedule/event/fosdem-2025-6712-welcome-to-fosdem-2025/
 */
const CONTENT_DETAILS_URL_REGEX = /^https?:\/\/(?:archive\.)?fosdem\.org\/(\d{4})\/schedule\/event\/([^\/?#]+)/i;

/**
 * Matches direct video file URLs on video.fosdem.org.
 * Captures: Group 1 = year, Group 2 = room directory, Group 3 = slug (without extension)
 * @example https://video.fosdem.org/2025/janson/fosdem-2025-6712-welcome-to-fosdem-2025.mp4
 */
const VIDEO_FILE_URL_REGEX = /^https?:\/\/video\.fosdem\.org\/(\d{4})\/([^\/?#]+)\/([^\/?#]+?)(?:\.av1)?\.(?:mp4|webm|vtt)(?:[?#].*)?$/;

const CHANNEL_URL_REGEX = /^https?:\/\/video\.fosdem\.org\/?$/;

/**
 * Matches fosdem.org speaker pages, with or without a year, and captures the speaker slug.
 * @example https://fosdem.org/2026/schedule/speaker/michiel_leenaars/
 */
const SPEAKER_URL_REGEX = /^https?:\/\/(?:archive\.)?fosdem\.org\/(?:\d{4}\/)?schedule\/speaker\/([^\/?#]+)/i;

/**
 * Matches edition playlist URLs and captures the year and the optional filter query.
 * @example https://video.fosdem.org/2026/?track=Python
 */
const PLAYLIST_URL_REGEX = /^https?:\/\/video\.fosdem\.org\/(\d{4})\/?(\?[^#]*)?$/;

/** Query parameter (value "1") that tells a year channel apart from the edition playlist, which uses the same path. */
const CHANNEL_URL_PARAM = "channel";

let config = {};
let settings = {};
let state = {
    editions: { years: [], banners: {}, fetchedAt: 0 }
};
// Not persisted, so a restarted plugin requests editions right away
let editionsRetryAt = 0;

/** Restores the saved editions cache, then refreshes it if it is older than EDITIONS_TTL_MS. */
source.enable = function (pluginConfig, pluginSettings, savedState) {
    config = pluginConfig;
    settings = pluginSettings;

    if (savedState) {
        try {
            const parsed = JSON.parse(savedState);
            if (parsed.editions) {
                state.editions = parsed.editions;
            }
        } catch (error) {
            log(`Failed to parse saved state: ${error.message}`);
        }
    }

    fetchEditions();
};

/** Saves the editions cache, so a restarted plugin skips /editions while the cache is fresh. */
source.saveState = function () {
    return JSON.stringify({
        editions: state.editions
    });
};

/** Talks of every edition, newest first. */
source.getHome = function () {
    return new FOSDEMPager(1, (page) => fetchEventsPage({}, page));
};

/** Matches the main channel, a year channel (/{year}/?channel=1) or a speaker profile URL. */
source.isChannelUrl = function (url) {
    return CHANNEL_URL_REGEX.test(url)
        || !!getYearFromChannelUrl(url)
        || !!getSpeakerSlugFromUrl(url);
};

source.getChannel = function (url) {
    const speakerSlug = getSpeakerSlugFromUrl(url);
    if (speakerSlug) {
        return fetchSpeakerChannel(speakerSlug);
    }

    const year = getYearFromChannelUrl(url);
    if (year) {
        return createYearChannel(year);
    }

    return createMainChannel();
};

source.getChannelCapabilities = function () {
    return {
        types: [Type.Feed.Videos, Type.Feed.Playlists],
        sorts: [Type.Order.Chronological]
    };
};

source.getChannelContents = function (url, type, order, filters) {
    if (type === Type.Feed.Playlists) {
        return source.getChannelPlaylists(url);
    }

    const speakerSlug = getSpeakerSlugFromUrl(url);
    if (speakerSlug) {
        return new FOSDEMPager(1, (page) => fetchSpeakerEventsPage(speakerSlug, page));
    }

    // Null on the main channel, which lists every edition
    const year = getYearFromChannelUrl(url);
    // The apps cache subscription items by author URL, so main-channel items carry the main channel as author
    const author = year ? null : mainAuthor();
    return new FOSDEMPager(1, (page) => fetchEventsPage({ year, author }, page));
};

source.getChannelPlaylists = function (url) {
    const speakerSlug = getSpeakerSlugFromUrl(url);
    const year = getYearFromChannelUrl(url);
    return new FOSDEMPager(1, (page) => fetchCategoryListPage(year, speakerSlug, page));
};

/** Year-channel URLs share the edition playlist path and are left out. */
source.isPlaylistUrl = function (url) {
    return PLAYLIST_URL_REGEX.test(url) && !getYearFromChannelUrl(url);
};

source.getPlaylist = function (url) {
    const playlist = parsePlaylistUrl(url);
    if (!playlist) {
        throw new ScriptException(`Invalid playlist URL: ${url}`);
    }

    const fetchPage = (page) => fetchPlaylistPage(playlist, page);
    const firstPage = fetchPage(1);
    const { id, name } = describePlaylist(playlist.year, playlist);
    return new PlatformPlaylistDetails({
        id: fosdemId(id),
        name,
        author: firstPage.speakerAuthor || mainAuthor(),
        url,
        thumbnail: getEditionBannerUrl(playlist.year),
        videoCount: firstPage.totalResults,
        contents: new FOSDEMPager(1, fetchPage, firstPage)
    });
};

source.isContentDetailsUrl = function (url) {
    return CONTENT_DETAILS_URL_REGEX.test(url) || VIDEO_FILE_URL_REGEX.test(url);
};

source.getContentDetails = function (url) {
    const parsed = parseContentUrl(url);
    if (!parsed) {
        throw new ScriptException(`Invalid content URL: ${url}`);
    }

    const event = fetchEvent(parsed.year, parsed.slug, parsed.speakerSlug);
    if (!event) {
        throw new ScriptException(`Event not found: ${parsed.slug}`);
    }

    if (!event.mp4Url && !event.webmUrl) {
        throw new ScriptException("No video sources available for this event");
    }

    const author = event.speakerName ? speakerAuthor(event.speakerSlug, event.speakerName) : null;
    return createTalkVideo(event, author);
};

/** Recommendations only enrich the details page, so a failed request returns an empty pager. */
source.getContentRecommendations = function (url) {
    const parsed = parseContentUrl(url);
    if (!parsed) {
        return new ContentPager([], false);
    }

    let data;
    try {
        data = httpGET({
            url: apiUrl(`/events/${parsed.year}/${encodeURIComponent(parsed.slug)}/recommendations`, { pageSize: ITEMS_PER_PAGE })
        });
    } catch (error) {
        log(`Failed to fetch recommendations: ${error.message}`);
        return new ContentPager([], false);
    }

    return new ContentPager(data.items.map((item) => createTalkVideo(item)), false);
};

source.getSearchCapabilities = function () {
    return new ResultCapabilities(
        [Type.Feed.Videos, Type.Feed.Playlists],
        [],
        [createYearFilterGroup(), ...buildCategoryFilterGroups()]
    );
};

source.search = function (query, type, order, filters) {
    if (isBlank(query)) {
        return new ContentPager([], false);
    }

    return new FOSDEMPager(1, (page) => fetchSearchPage(query, filters, page));
};

source.searchPlaylists = function (query) {
    if (isBlank(query)) {
        return new ContentPager([], false);
    }

    return new FOSDEMPager(1, (page) => fetchPlaylistSearchPage(query, page));
};

source.searchChannels = function (query) {
    if (isBlank(query)) {
        return new ContentPager([], false);
    }

    const firstCursor = { pending: findFosdemChannels(query.trim()), speakerPage: 1, speakersLeft: true };
    return new FOSDEMPager(firstCursor, (cursor) => fetchChannelSearchPage(query.trim(), cursor));
};

/** The year filter is left out because a year channel implies it. */
source.getSearchChannelContentsCapabilities = function () {
    return new ResultCapabilities(
        [Type.Feed.Videos],
        [],
        buildCategoryFilterGroups()
    );
};

source.searchChannelContents = function (channelUrl, query, type, order, filters) {
    if (isBlank(query)) {
        return new ContentPager([], false);
    }

    const channelFilters = { ...filters };

    const speakerSlug = getSpeakerSlugFromUrl(channelUrl);
    const year = getYearFromChannelUrl(channelUrl);
    if (speakerSlug) {
        channelFilters.speaker = [speakerSlug];
    } else if (year) {
        channelFilters.year = [String(year)];
    }
    return new FOSDEMPager(1, (page) => fetchSearchPage(query, channelFilters, page));
};

/** Suggestions are best effort, so failures return none. */
source.searchSuggestions = function (query) {
    if (isBlank(query)) {
        return [];
    }

    let data;
    try {
        // No retries: suggestions are requested while typing and a rate-limit wait would stall the search box
        data = httpGET({
            url: apiUrl("/autocomplete", { q: query, limit: SUGGESTION_LIMIT }),
            retries: 0
        });
    } catch (error) {
        log(`Failed to fetch search suggestions: ${error.message}`);
        return [];
    }

    return data.suggestions.map((suggestion) => suggestion.text);
};

function isBlank(text) {
    return !text || text.trim().length === 0;
}

/** Builds an API URL; parameters that are null, undefined or empty are left out. */
function apiUrl(path, params = {}) {
    const query = Object.keys(params)
        .filter((name) => params[name] !== null && params[name] !== undefined && params[name] !== "")
        .map((name) => `${name}=${encodeURIComponent(params[name])}`)
        .join("&");
    return SEARCH_API_BASE_URL + path + (query ? "?" + query : "");
}

function fetchApiPage(path, page, params = {}) {
    return httpGET({ url: apiUrl(path, { page, pageSize: ITEMS_PER_PAGE, ...params }) });
}

function pageResult(data, page, results) {
    return { results, hasMore: page < data.totalPages, nextCursor: page + 1 };
}

/**
 * Fetches a talk, or null when it does not exist. With speakerSlug naming one of its speakers,
 * the API sets speakerName and speakerSlug to that speaker's profile.
 */
function fetchEvent(year, slug, speakerSlug) {
    return httpGET({ url: apiUrl(`/events/${year}/${encodeURIComponent(slug)}`, { speaker: speakerSlug }), nullOnNotFound: true });
}

/**
 * Fetches one page of /events, newest first. Without a year it covers every edition;
 * the author defaults to each item's year channel.
 */
function fetchEventsPage({ year, author }, page) {
    const data = fetchApiPage("/events", page, { year });
    return pageResult(data, page, data.items.map((item) => createTalkVideo(item, author)));
}

/** One page of an edition playlist, plus totalResults and speakerAuthor (set when the API knows the speaker's name). */
function fetchPlaylistPage(playlist, page) {
    const sort = settings.playlistSort === 0 ? "asc" : "desc";
    const data = fetchApiPage("/events", page, { sort, ...playlist });
    const speaker = playlist.speaker;
    const author = speaker && data.speakerName ? speakerAuthor(speaker, data.speakerName) : null;
    const videos = data.items.map((item) => createTalkVideo(speaker ? withSpeakerHint(item, speaker) : item, author));
    return { ...pageResult(data, page, videos), totalResults: data.totalResults, speakerAuthor: author };
}

function fetchSpeakerEventsPage(slug, page) {
    const data = fetchApiPage(`/speakers/${encodeURIComponent(slug)}/events`, page);
    // The API returns an empty name for an unknown slug
    const author = data.speakerName ? speakerAuthor(data.speakerSlug, data.speakerName) : null;
    return pageResult(data, page, data.items.map((item) => createTalkVideo(withSpeakerHint(item, slug), author)));
}

/**
 * Fetches one page of edition, track, room and type playlists, newest year first.
 * A null year covers every edition; a speaker slug limits them to that speaker's talks.
 */
function fetchCategoryListPage(year, speakerSlug, page) {
    const data = fetchApiPage("/categories/list", page, { year, speaker: speakerSlug });
    const author = speakerSlug ? speakerAuthor(speakerSlug, data.speakerName || speakerSlug) : null;
    return pageResult(data, page, data.items.map((item) => createPlaylistFromCategoryMatch(item, speakerSlug, author)));
}

function fetchSearchPage(query, filters, page) {
    const params = { q: query };
    for (const filterName of SEARCH_FILTERS) {
        if (filters && filters[filterName]) {
            params[filterName] = filters[filterName][0];
        }
    }
    const data = fetchApiPage("/search", page, params);
    return pageResult(data, page, data.items.map((item) => createTalkVideo(item)));
}

function fetchPlaylistSearchPage(query, page) {
    const data = fetchApiPage("/categories/search", page, { q: query });
    return pageResult(data, page, data.items.map((item) => createPlaylistFromCategoryMatch(item)));
}

/**
 * Matching FOSDEM channels come first, then speakers. Speaker pages are fetched until a page is full,
 * and the overflow carries over in the cursor.
 */
function fetchChannelSearchPage(query, { pending, speakerPage, speakersLeft }) {
    let channels = pending;
    while (channels.length < ITEMS_PER_PAGE && speakersLeft) {
        const data = fetchApiPage("/speakers/search", speakerPage, { q: query });
        channels = channels.concat(data.items.map(createSpeakerChannel));
        speakersLeft = speakerPage < data.totalPages;
        speakerPage++;
    }
    const remaining = channels.slice(ITEMS_PER_PAGE);
    return {
        results: channels.slice(0, ITEMS_PER_PAGE),
        hasMore: remaining.length > 0 || speakersLeft,
        nextCursor: { pending: remaining, speakerPage, speakersLeft }
    };
}

/** The main channel when the query is part of "FOSDEM", then each edition whose "FOSDEM {year}" name contains it. */
function findFosdemChannels(query) {
    const lowerQuery = query.toLowerCase();
    const channels = [];
    if ("fosdem".includes(lowerQuery)) {
        channels.push(createMainChannel());
    }
    for (const year of getEditions().years) {
        if (`fosdem ${year}`.includes(lowerQuery)) {
            channels.push(createYearChannel(year));
        }
    }
    return channels;
}

/** Filters only enrich the search capabilities, so a failed request returns empty lists. */
function fetchSearchFilters() {
    let data;
    try {
        data = httpGET({ url: apiUrl("/categories") });
    } catch (error) {
        log(`Failed to fetch search filters: ${error.message}`);
        return { tracks: [], rooms: [], types: [] };
    }
    return {
        tracks: data.tracks.map((track) => track.name),
        rooms: data.rooms.map((room) => room.name),
        types: data.types.map((type) => type.name)
    };
}

function createYearFilterGroup() {
    return createFilterGroup("Year", "year", getEditions().years.map(String));
}

function buildCategoryFilterGroups() {
    const filters = fetchSearchFilters();
    const groups = [createFilterGroup("Type", "type", filters.types)];
    if (filters.tracks.length > 0) {
        groups.push(createFilterGroup("Track", "track", filters.tracks));
    }
    if (filters.rooms.length > 0) {
        groups.push(createFilterGroup("Room", "room", filters.rooms));
    }

    return groups;
}

function createFilterGroup(name, id, values) {
    return new FilterGroup(name, values.map((value) => new FilterCapability(value, value, value)), false, id);
}

/**
 * GET with the default headers, returning the parsed JSON. Network errors, timeouts, 429 and 5xx are retried;
 * other failures throw a ScriptException at once. With nullOnNotFound, a 404 returns null.
 */
function httpGET({ url, retries = REQUEST_RETRIES, nullOnNotFound = false }) {
    const maxAttempts = retries + 1;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let response;
        try {
            response = http.GET(url, REQUEST_HEADERS, false);
        } catch (error) {
            log(`Request error on ${url}: ${error}`);
            lastError = new ScriptException(`Request error: ${url}`);
            continue;
        }

        if (response.code === 429) {
            log(`Rate limited on ${url}`);
            lastError = new ScriptException(`Rate limited [${response.code}]: ${url}`);
            if (attempt < maxAttempts) {
                bridge.sleep(RATE_LIMIT_WAIT_MS);
            }
            continue;
        }
        // Android reports a socket timeout as 408
        if (response.code === 408 || response.code >= 500) {
            log(`Server error ${response.code} on ${url}`);
            lastError = new ScriptException(`Server error [${response.code}]: ${url}`);
            continue;
        }
        if (response.code === 404 && nullOnNotFound) {
            return null;
        }
        if (!response.isOk) {
            throw new ScriptException(`Request failed [${response.code}]: ${url}`);
        }
        if (!response.body) {
            throw new ScriptException(`Empty response: ${url}`);
        }
        try {
            return JSON.parse(response.body);
        } catch (error) {
            throw new ScriptException(`Invalid response from ${url}: ${error.message}`);
        }
    }

    log(`Request failed after ${maxAttempts} attempt(s): ${url}`);
    throw lastError;
}

/** Query parameters of a URL; empty when it does not parse. Android's URL polyfill also throws on malformed escapes. */
function getSearchParams(url) {
    try {
        return new URL(url).searchParams;
    } catch (error) {
        return new URLSearchParams();
    }
}

/**
 * Refreshes the editions cache once it is older than EDITIONS_TTL_MS, waiting EDITIONS_RETRY_MS after a failure.
 * A failed or empty response keeps the existing cache, even when stale.
 */
function fetchEditions() {
    const now = Date.now();
    if (state.editions.years.length > 0 && now - state.editions.fetchedAt < EDITIONS_TTL_MS) {
        return;
    }
    if (now < editionsRetryAt) {
        return;
    }

    let data;
    try {
        data = httpGET({ url: apiUrl("/editions") });
    } catch (error) {
        log(`Failed to fetch editions: ${error.message}`);
        // Counted from the end of the request: retried slow failures can outlast the delay
        editionsRetryAt = Date.now() + EDITIONS_RETRY_MS;
        return;
    }
    if (data.editions.length === 0) {
        log("Editions response is empty");
        editionsRetryAt = Date.now() + EDITIONS_RETRY_MS;
        if (state.editions.years.length > 0) {
            return;
        }
    }

    const banners = {};
    for (const edition of data.editions) {
        if (edition.bannerUrl) {
            banners[edition.year] = edition.bannerUrl;
        }
    }
    state.editions = {
        years: data.editions.map((edition) => edition.year),
        banners,
        fetchedAt: Date.now()
    };
}

function getEditions() {
    fetchEditions();
    return state.editions;
}

function getEditionBannerUrl(year) {
    return getEditions().banners[year] || "";
}

function getMainBannerUrl() {
    return getEditionBannerUrl(getEditions().years[0]);
}

function getMainThumbnailUrl() {
    const years = getEditions().years;
    if (years.length === 0) {
        return CHANNEL_THUMBNAIL_URL;
    }
    return `${SCHEDULE_BASE_URL}/${years[0]}/apple-touch-icon.png`;
}

/** Converts an ISO 8601 date to Unix seconds, or 0 when it is missing or does not parse. */
function parseEventDate(isoDate) {
    const timestampMs = new Date(isoDate).getTime();
    return isNaN(timestampMs) ? 0 : Math.floor(timestampMs / 1000);
}

/** Parses a talk page or video file URL into { year, slug, speakerSlug }, with the slug percent-decoded. */
function parseContentUrl(url) {
    let match = url.match(CONTENT_DETAILS_URL_REGEX);
    if (match) {
        return { year: match[1], slug: decodeSlug(match[2]), speakerSlug: getSearchParams(url).get("speakerSlug") };
    }

    match = url.match(VIDEO_FILE_URL_REGEX);
    if (match) {
        return { year: match[1], slug: decodeSlug(match[3]) };
    }

    return null;
}

function getSpeakerSlugFromUrl(url) {
    const match = url.match(SPEAKER_URL_REGEX);
    return match ? decodeSlug(match[1]) : null;
}

/** Percent-decodes a URL slug so it is not encoded twice in API URLs; malformed encoding is kept. */
function decodeSlug(rawSlug) {
    try {
        return decodeURIComponent(rawSlug);
    } catch (error) {
        return rawSlug;
    }
}

function getYearFromChannelUrl(url) {
    const match = url.match(PLAYLIST_URL_REGEX);
    if (!match || getSearchParams(url).get(CHANNEL_URL_PARAM) !== "1") {
        return null;
    }
    return parseInt(match[1], 10);
}

/** Parses an edition playlist URL into { year, track, room, type, speaker }, leaving out absent filters. */
function parsePlaylistUrl(url) {
    const match = url.match(PLAYLIST_URL_REGEX);
    if (!match) {
        return null;
    }

    const playlist = { year: parseInt(match[1], 10) };
    const params = getSearchParams(url);
    for (const filterName of [...CATEGORY_FILTERS, "speaker"]) {
        if (params.has(filterName)) {
            playlist[filterName] = params.get(filterName);
        }
    }
    return playlist;
}

/** ID, name and URL of an edition playlist. Every filter goes into the ID, so filter combinations stay distinct. */
function describePlaylist(year, filters) {
    let id = `fosdem-${year}`;
    let name = `FOSDEM ${year}`;
    const query = [];
    if (filters.speaker) {
        id += `-speaker-${filters.speaker}`;
    }
    for (const filterName of CATEGORY_FILTERS) {
        const value = filters[filterName];
        if (value) {
            id += `-${filterName}-${value}`;
            name += ` - ${capitalize(filterName)} ${value}`;
            query.push(`${filterName}=${encodeURIComponent(value)}`);
        }
    }
    if (filters.speaker) {
        query.push(`speaker=${encodeURIComponent(filters.speaker)}`);
    }
    const url = `${BASE_URL}/${year}/` + (query.length > 0 ? "?" + query.join("&") : "");
    return { id, name, url };
}

/** Formats turned off in the settings are left out; the preferred format gets priority. */
function buildVideoSources(event, durationSeconds) {
    const sources = [];
    const wantMp4 = settings.enableMp4 !== false;
    const wantWebm = settings.enableWebm !== false;
    const priorityWebm = settings.prioritySource === 1;

    if (event.mp4Url && wantMp4) {
        const mp4Source = new VideoUrlSource({
            name: "MP4",
            url: event.mp4Url,
            width: VIDEO_WIDTH,
            height: VIDEO_HEIGHT,
            container: "video/mp4",
            codec: "h264",
            duration: durationSeconds
        });
        mp4Source.priority = !priorityWebm;
        sources.push(mp4Source);
    }

    if (event.webmUrl && wantWebm) {
        const isAv1 = event.webmUrl.endsWith(".av1.webm");
        const webmSource = new VideoUrlSource({
            name: isAv1 ? "AV1/WebM" : "WebM",
            url: event.webmUrl,
            width: VIDEO_WIDTH,
            height: VIDEO_HEIGHT,
            container: "video/webm",
            codec: isAv1 ? "av1" : "vp9",
            duration: durationSeconds
        });
        webmSource.priority = priorityWebm;
        sources.push(webmSource);
    }

    return sources;
}

function buildSubtitles(event) {
    return event.subtitles
        .slice()
        .sort((first, second) => second.priority - first.priority)
        .map((subtitle) => ({
            name: subtitle.label || subtitle.language,
            url: subtitle.url,
            format: "text/vtt",
            language: subtitle.language
        }));
}

function buildDescription(event) {
    const parts = [];

    if (event.speakers.length > 0) {
        const speakerNames = event.speakers.map((speaker) => {
            // Schedules before 2026 have no speaker slugs
            if (IS_ANDROID && speaker.slug) {
                return `<a href="${buildSpeakerUrl(speaker.slug)}">${escapeHtml(speaker.name)}</a>`;
            }
            return escapeHtml(speaker.name);
        });
        parts.push(`Speakers: ${speakerNames.join(", ")}`);
    }
    if (event.track) {
        parts.push(formatMetadataLink("Track", "track", event.track, event.year));
    }
    if (event.type) {
        parts.push(formatMetadataLink("Type", "type", event.type, event.year));
    }
    if (event.room) {
        parts.push(formatMetadataLink("Room", "room", event.room, event.year));
    }

    const resourceLinks = [];
    let feedbackLink = null;
    for (const link of event.links) {
        if (link.type === "feedback") {
            feedbackLink = link;
            continue;
        }
        const text = escapeHtml(link.text || link.type);
        resourceLinks.push(IS_ANDROID ? `<a href="${escapeHtml(link.href)}">${text}</a>` : text);
    }
    if (resourceLinks.length > 0) {
        parts.push(`Links: ${resourceLinks.join(" | ")}`);
    }
    if (feedbackLink) {
        parts.push(IS_ANDROID ? `<a href="${escapeHtml(feedbackLink.href)}">Submit Feedback</a>` : "Submit Feedback");
    }

    if (event.abstract) {
        parts.push("", event.abstract);
    }
    if (event.description && event.description !== event.abstract) {
        parts.push("", event.description);
    }

    parts.push("", LICENSE_NOTICE);
    return parts.join("\n");
}

/** Escapes quotes too, since the result also goes into href values. */
function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function capitalize(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatMetadataLink(label, filterName, value, year) {
    if (IS_ANDROID) {
        return `${label}: <a href="${BASE_URL}/${year}/?${filterName}=${encodeURIComponent(value)}">${escapeHtml(value)}</a>`;
    }
    return `${label}: ${escapeHtml(value)}`;
}

/** Returns the URL unchanged when it does not parse. */
function setSearchParam(url, name, value) {
    try {
        const parsedUrl = new URL(url);
        parsedUrl.searchParams.set(name, value);
        return parsedUrl.toString();
    } catch (error) {
        return url;
    }
}

/** Copy of a talk whose URL names the speaker, so its details page uses that speaker as author. */
function withSpeakerHint(event, speakerSlug) {
    return { ...event, url: setSearchParam(event.url, "speakerSlug", speakerSlug) };
}

function fosdemId(suffix) {
    return new PlatformID(PLATFORM, suffix, config.id);
}

function buildYearChannelUrl(year) {
    return `${BASE_URL}/${year}/?${CHANNEL_URL_PARAM}=1`;
}

function buildSpeakerUrl(slug) {
    return `${SCHEDULE_BASE_URL}/schedule/speaker/${encodeURIComponent(slug)}/`;
}

function mainAuthor() {
    return new PlatformAuthorLink(fosdemId("fosdem"), "FOSDEM", BASE_URL, getMainThumbnailUrl());
}

function yearAuthor(year) {
    return new PlatformAuthorLink(
        fosdemId(`fosdem-channel-${year}`),
        `FOSDEM ${year}`,
        buildYearChannelUrl(year),
        getEditionBannerUrl(year) || getMainThumbnailUrl()
    );
}

function speakerAuthor(slug, name) {
    return new PlatformAuthorLink(fosdemId(`speaker-${slug}`), name, buildSpeakerUrl(slug), getMainThumbnailUrl());
}

/** Speaker suffix of a talk title, such as " - Andrew Nesbitt, Benjamin Nickolls". */
function buildSpeakerSuffix(event) {
    if (event.speakers.length === 0) {
        return "";
    }
    return " - " + event.speakers.map((speaker) => speaker.name).join(", ");
}

function buildBaseVideoFields(event, author) {
    return {
        id: fosdemId(String(event.id)),
        name: event.title + buildSpeakerSuffix(event),
        thumbnails: new Thumbnails(event.thumbnailUrl ? [new Thumbnail(event.thumbnailUrl, VIDEO_HEIGHT)] : []),
        author: author || yearAuthor(event.year),
        uploadDate: parseEventDate(event.date),
        duration: event.duration || -1,
        viewCount: 0,
        url: event.url
    };
}

/**
 * Returns a PlatformVideo when the format settings leave no source.
 * The author defaults to the talk's year channel.
 */
function createTalkVideo(event, author) {
    const fields = buildBaseVideoFields(event, author);
    const sources = buildVideoSources(event, fields.duration);
    if (sources.length === 0) {
        return new PlatformVideo(fields);
    }

    fields.description = buildDescription(event);
    fields.video = new VideoSourceDescriptor(sources);
    fields.subtitles = buildSubtitles(event);

    const details = new PlatformVideoDetails(fields);
    details.getContentRecommendations = () => source.getContentRecommendations(event.url);
    return details;
}

/** The speaker filter stays in the playlist ID and URL; the author defaults to the main channel. */
function createPlaylistFromCategoryMatch(item, speakerSlug, author) {
    const filters = { speaker: speakerSlug };
    if (item.category !== "edition") {
        filters[item.category] = item.name;
    }
    const { id, name, url } = describePlaylist(item.year, filters);
    return new PlatformPlaylist({
        id: fosdemId(id),
        name,
        author: author || mainAuthor(),
        thumbnail: getEditionBannerUrl(item.year),
        url,
        videoCount: item.count
    });
}

function createMainChannel() {
    return new PlatformChannel({
        id: fosdemId("fosdem"),
        name: "FOSDEM",
        thumbnail: getMainThumbnailUrl(),
        banner: getMainBannerUrl(),
        subscribers: 0,
        description: CHANNEL_DESCRIPTION,
        url: BASE_URL,
        links: {
            "Website": "https://fosdem.org",
            "Mastodon": "https://fosstodon.org/@fosdem",
            "Bluesky": "https://bsky.app/profile/fosdem.org",
            "LinkedIn": "https://www.linkedin.com/company/fosdem/",
            "Matrix": "https://matrix.to/#/#fosdem:fosdem.org"
        }
    });
}

function createYearChannel(year) {
    const banner = getEditionBannerUrl(year);
    return new PlatformChannel({
        id: fosdemId(`fosdem-channel-${year}`),
        name: `FOSDEM ${year}`,
        thumbnail: banner || getMainThumbnailUrl(),
        banner: banner || getMainBannerUrl(),
        subscribers: 0,
        description: `FOSDEM ${year} talks.\n\n${CHANNEL_DESCRIPTION}`,
        url: buildYearChannelUrl(year),
        links: { "Website": `${SCHEDULE_BASE_URL}/${year}/` }
    });
}

function createSpeakerChannel(speaker) {
    return new PlatformChannel({
        id: fosdemId(`speaker-${speaker.slug}`),
        name: speaker.name,
        thumbnail: getMainThumbnailUrl(),
        banner: getMainBannerUrl(),
        subscribers: 0,
        description: `${speaker.biography}\n\n${LICENSE_NOTICE}`,
        url: buildSpeakerUrl(speaker.slug),
        links: {}
    });
}

function fetchSpeakerChannel(slug) {
    const speaker = httpGET({ url: apiUrl(`/speakers/${encodeURIComponent(slug)}`), nullOnNotFound: true });
    if (!speaker) {
        throw new ScriptException(`Speaker not found: ${slug}`);
    }
    return createSpeakerChannel(speaker);
}

/**
 * Fetches each page through a callback. The hosts pick the pager type from the called method, so one class serves every list.
 * A failed page throws before a new pager exists, so the current one stays usable for a retry.
 */
class FOSDEMPager extends ContentPager {
    constructor(cursor, fetchPage, pageData) {
        const data = pageData || fetchPage(cursor);
        super(data.results, data.hasMore);
        this.fetchPage = fetchPage;
        this.nextCursor = data.nextCursor;
    }

    nextPage() {
        return new FOSDEMPager(this.nextCursor, this.fetchPage);
    }
}

log("loaded");
