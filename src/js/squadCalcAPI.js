import { App } from "../app.js";

/**
 * Sends weapon data to the API via a POST request.
 * @param {Object} markerData - The data object to be sent to the API.
 * @returns {Promise<void>} A promise that resolves if the data is successfully sent, or logs an error if not.
 * @throws {Error} Logs details of any network or HTTP errors encountered during the request.
 */
export function sendMarkerData(markerData) {
    // 社区共享属于在线功能，直连上游（离线数据目录不提供写接口）
    fetch(`${process.env.REMOTE_API}/post/weapons`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-App-Version": App.version
        },
        body: JSON.stringify(markerData)
    }).then(response => {
        if (!response.ok) {
            console.debug("[API] HTTP error:", response.status);
        }
    }).catch(error => {
        console.debug("[API] Error sending marker data:", error);
    });
}

/**
 * Sends FOB marker data to the API via a POST request.
 * @param {Object} markerData - The data object to be sent to the API.
 * @returns {Promise<void>} A promise that resolves if the data is successfully sent, or logs an error if not.
 * @throws {Error} Logs details of any network or HTTP errors encountered during the request.
 */
export function sendFOBData(FOBData) {
    fetch(`${process.env.REMOTE_API}/post/fobs`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-App-Version": App.version
        },
        body: JSON.stringify(FOBData)
    }).then(response => {
        if (!response.ok) {
            console.debug("[API] HTTP error:", response.status);
        }
    }).catch(error => {
        console.debug("[API] Error sending marker data:", error);
    });
}


/**
 * Sends target data to the API via a POST request.
 * @param {Object} targetData - The data object to be sent to the API.
 * @returns {Promise<void>} A promise that resolves if the data is successfully sent, or logs an error if not.
 */
export function sendTargetData(targetData) {
    fetch(`${process.env.REMOTE_API}/post/targets`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-App-Version": App.version
        },
        body: JSON.stringify(targetData)
    })
        .then(response => {
            if (!response.ok) {
                console.debug("[API] HTTP error:", response.status);
            }
        })
        .catch(error => {
            console.debug("[API] Error sending target data:", error);
        });
}


/**
 * Checks the health of the API by sending a request to the `/health` endpoint.
 * @returns {Promise<void>} A promise that resolves if the API is healthy, or logs an error if not.
 * @throws Will log an error if the network request fails or if the API response is not OK.
 */
export const checkApiHealth = async () => {
    try {
        const response = await fetch(`${process.env.API_URL}/health.json`);
        if (response.ok) {
            const data = await response.json();
            if (data.status === "OK") {
                console.log(`Connected to ${process.env.API_URL}`);
                if (data.version) $("#gameDataVersion").text(`Squad v${data.version}`);
                App.layerCounts = data.layers || {};
                App._renderModTiles();
                App.applyUrlIntent();
            }
        } else {
            console.error("Not connected to SquadCalc API");
            $("#gameDataVersion").text("Disconnected from API").addClass("error");
        }
    } catch (error) {
        console.error("[API] Not connected to SquadCalc API");
        console.debug("[API]", error);
        $("#gameDataVersion").text("Disconnected from API").addClass("error");
    }
};


/**
 * Fetches marker data for a specific map and weapon from the API.
 * @param {string} mapName - The name of the map to fetch marker data for.
 * @param {string} weapon - The weapon to filter the marker data by.
 * @returns {Promise<Object>} A promise that resolves with the fetched marker data in JSON format.
 * @throws {Error} Throws an error if the network request fails or the response is not OK.
 */
export async function fetchMarkersByMap(mapName, weapon) {
    // 社区热力图数据不在离线包内：直连上游（上游允许跨域），失败则返回空集
    const base = process.env.REMOTE_API;
    if (!base) return [];
    const url = `${base}/get/weapons?map=${encodeURIComponent(mapName)}&weapon=${encodeURIComponent(weapon)}`;
    try {
        const response = await fetch(url, { headers: { "X-App-Version": App.version } });
        if (!response.ok) return [];
        return await response.json();
    } catch (error) {
        console.debug("[API] Error fetching marker data:", error);
        return [];
    }
}

/**
 * 联机多人服务器列表：直接使用官方在线接口（squadcalc.app），不读取离线快照，
 * 保证看到的是实时数据。
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Object>} { servers: [...] }
 */
export async function fetchServers(options = {}) {
    const { signal } = options;
    const base = process.env.REMOTE_API;
    if (!base) throw new Error("[API] REMOTE_API 未配置");
    const r = await fetch(`${base}/get/servers`, { headers: { "X-App-Version": App.version }, signal });
    if (!r.ok) throw new Error(`[API] HTTP ${r.status}`);
    return await r.json();
}


/**
 * xxxxxxxxxxxxxxxxxxxxxx
 * @param {string} mapName - The name of the map to fetch layers data for.
 * @param {string[]} [mods] - Mod keys to include modded layers for.
 * @returns {Promise<Object>} A promise that resolves with the fetched marker data in JSON format.
 * @throws {Error} Throws an error if the network request fails or the response is not OK.
 */
export async function fetchLayersByMap(mapName, mods = []) {
    // 离线版：本地静态文件已包含该地图全部模组图层，mods 参数仅保留签名兼容
    const url = `${process.env.API_URL}/get/layers/${encodeURIComponent(mapName)}.json`;
    try {
        const response = await fetch(url, { headers: { "X-App-Version": App.version }, });
        if (!response.ok) { throw new Error("[API] Network response was not ok"); }
        const data = await response.json();
        return data;
    } catch (error) {
        console.debug("[API] Error fetching layers data:", error);
        throw error;
    }
}

/**
 * xxxxxxxxxxxxxxxxxxxxxx
 * @param {string} mapName - The name of the map to fetch layers data for.
 * @returns {Promise<Object>} A promise that resolves with the fetched marker data in JSON format.
 * @throws {Error} Throws an error if the network request fails or the response is not OK.
 */
export async function fetchLayerByName(layerName, options = {}) {
    // 离线版：直接读取本地静态 JSON
    const url = `${process.env.API_URL}/get/layer/${encodeURIComponent(layerName)}.json`;
    const { signal } = options; 
    try {
        const response = await fetch(url, {
            headers: { "X-App-Version": App.version },
            signal
        });
        if (!response.ok) { throw new Error("[API] Network response was not ok"); }
        const data = await response.json();
        return data;
    } catch (error) {
        console.debug("[API] Error fetching layers data:", error);
        throw error;
    }
}

/**
 * xxxxxxxxxxxxxxxxxxxxxx
 * @param {string} mapName - The name of the map to fetch layers data for.
 * @returns {Promise<Object>} A promise that resolves with the fetched marker data in JSON format.
 * @throws {Error} Throws an error if the network request fails or the response is not OK.
 */
export async function fetchUnitByName(unitName, options = {}) {
    const url = `${process.env.API_URL}/get/unit?name=${encodeURIComponent(unitName)}`;
    const { signal } = options;
    try {
        const response = await fetch(url, {
            headers: { "X-App-Version": App.version },
            signal
        });
        if (!response.ok) { throw new Error("Network response was not ok"); }
        const data = await response.json();
        return data;
    } catch (error) {
        console.debug("[API] Error fetching Unit data:", error);
        throw error;
    }
}