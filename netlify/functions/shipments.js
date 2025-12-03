export const handler = async (event, context) => {
    // 1. SECURE KEYS: Loaded from Netlify Environment Variables
    const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
    const API_KEY = process.env.FIREBASE_API_KEY;
    const COLLECTION = 'shipments';
    
    const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${COLLECTION}`;

    // --- HELPER: JSON -> Firestore Format ---
    const toFirestore = (data) => {
        const fields = {};
        for (const key in data) {
            const val = data[key];
            if (val instanceof Date) fields[key] = { timestampValue: val.toISOString() };
            else if (typeof val === 'string') fields[key] = { stringValue: val };
            else if (typeof val === 'number') fields[key] = { integerValue: val };
            else if (Array.isArray(val)) {
                fields[key] = { arrayValue: { values: val.map(item => ({ mapValue: { fields: toFirestore(item).fields } })) } };
            } 
            else if (typeof val === 'object' && val !== null) fields[key] = { mapValue: { fields: toFirestore(val).fields } };
        }
        return { fields };
    };

    // --- HELPER: Firestore Format -> JSON ---
    const fromFirestore = (doc) => {
        const fields = doc.fields || {};
        const data = { id: doc.name.split('/').pop() };
        
        const parseValue = (valObj) => {
            if (valObj.stringValue !== undefined) return valObj.stringValue;
            if (valObj.integerValue !== undefined) return parseInt(valObj.integerValue);
            if (valObj.timestampValue !== undefined) return valObj.timestampValue;
            if (valObj.mapValue !== undefined) {
                const map = {};
                for (const k in valObj.mapValue.fields) map[k] = parseValue(valObj.mapValue.fields[k]);
                return map;
            }
            if (valObj.arrayValue !== undefined) {
                return (valObj.arrayValue.values || []).map(parseValue);
            }
            return null;
        };

        for (const key in fields) {
            data[key] = parseValue(fields[key]);
        }
        return data;
    };

    // --- MAIN API LOGIC ---
    try {
        const method = event.httpMethod;
        const { id } = event.queryStringParameters || {};
        
        // GET
        if (method === 'GET') {
            const url = id ? `${BASE_URL}/${id}?key=${API_KEY}` : `${BASE_URL}?key=${API_KEY}`;
            const response = await fetch(url);
            const data = await response.json();
            
            if (data.error) throw new Error(data.error.message);

            let cleanData;
            if (id) {
                cleanData = fromFirestore(data);
            } else {
                cleanData = (data.documents || []).map(fromFirestore);
            }
            return { statusCode: 200, body: JSON.stringify(cleanData) };
        }

        // POST (Create)
        if (method === 'POST') {
            const payload = JSON.parse(event.body);
            const customId = payload.trackingNumber;
            
            // Check existence
            const check = await fetch(`${BASE_URL}/${customId}?key=${API_KEY}`);
            if (check.ok) return { statusCode: 400, body: JSON.stringify({ error: "Tracking number exists" }) };

            const firestoreBody = toFirestore(payload);
            const url = `${BASE_URL}?documentId=${customId}&key=${API_KEY}`;
            
            const response = await fetch(url, { method: 'POST', body: JSON.stringify(firestoreBody) });
            const data = await response.json();
            
            if (data.error) throw new Error(data.error.message);
            return { statusCode: 200, body: JSON.stringify({ message: "Created", id: customId }) };
        }

        // DELETE
        if (method === 'DELETE') {
            if (!id) return { statusCode: 400, body: "ID required" };
            await fetch(`${BASE_URL}/${id}?key=${API_KEY}`, { method: 'DELETE' });
            return { statusCode: 200, body: JSON.stringify({ message: "Deleted" }) };
        }

        // PATCH (Update Status)
        if (method === 'PATCH') {
             if (!id) return { statusCode: 400, body: "ID required" };
             const payload = JSON.parse(event.body);
             
             // Get existing to merge array
             const existingRes = await fetch(`${BASE_URL}/${id}?key=${API_KEY}`);
             if (!existingRes.ok) return { statusCode: 404, body: "Not found" };
             const existingDoc = await existingRes.json();
             const currentData = fromFirestore(existingDoc);
             
             if (payload.statusUpdate) {
                 if (!currentData.statusHistory) currentData.statusHistory = [];
                 currentData.statusHistory.push(payload.statusUpdate);
                 currentData.lastUpdate = new Date().toISOString();
             }

             const firestoreBody = toFirestore(currentData);
             await fetch(`${BASE_URL}/${id}?key=${API_KEY}`, {
                 method: 'PATCH',
                 body: JSON.stringify(firestoreBody)
             });
             
             return { statusCode: 200, body: JSON.stringify({ message: "Updated" }) };
        }

        return { statusCode: 405, body: "Method Not Allowed" };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};


