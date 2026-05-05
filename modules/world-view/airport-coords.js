"use strict"

/**
 * WorldViewAirportCoords — IATA → {lat, lon, name} lookup.
 *
 * Curated from public-domain airport registries. ~250 airports covering
 * the major hubs and secondary airports a typical AirlineSim network
 * touches. Missing IATAs return null; the world-map view hides bubbles
 * for those and surfaces a "{N} dest(s) without coordinates" footer
 * note. Expand the table as new destinations show up.
 *
 * Lat/lon are decimal degrees (WGS84). Equirectangular projection in
 * world-map.js is straight-through:
 *     x = (lon + 180) / 360
 *     y = (90 - lat) / 180
 */
;(function () {
    const COORDS = {
        // North America — USA
        ATL: {lat:33.6367, lon:-84.4281, name:"Atlanta"},
        ORD: {lat:41.9742, lon:-87.9073, name:"Chicago O'Hare"},
        DFW: {lat:32.8998, lon:-97.0403, name:"Dallas/Fort Worth"},
        DEN: {lat:39.8617, lon:-104.6731, name:"Denver"},
        LAX: {lat:33.9416, lon:-118.4085, name:"Los Angeles"},
        JFK: {lat:40.6413, lon:-73.7781, name:"New York JFK"},
        EWR: {lat:40.6925, lon:-74.1687, name:"Newark"},
        LGA: {lat:40.7769, lon:-73.8740, name:"New York LaGuardia"},
        SFO: {lat:37.6213, lon:-122.3790, name:"San Francisco"},
        SEA: {lat:47.4502, lon:-122.3088, name:"Seattle"},
        LAS: {lat:36.0840, lon:-115.1537, name:"Las Vegas"},
        MCO: {lat:28.4312, lon:-81.3081, name:"Orlando"},
        MIA: {lat:25.7959, lon:-80.2870, name:"Miami"},
        PHX: {lat:33.4343, lon:-112.0117, name:"Phoenix"},
        IAH: {lat:29.9844, lon:-95.3414, name:"Houston Intercontinental"},
        BOS: {lat:42.3656, lon:-71.0096, name:"Boston"},
        MSP: {lat:44.8848, lon:-93.2223, name:"Minneapolis-St Paul"},
        DTW: {lat:42.2124, lon:-83.3534, name:"Detroit"},
        PHL: {lat:39.8744, lon:-75.2424, name:"Philadelphia"},
        CLT: {lat:35.2140, lon:-80.9431, name:"Charlotte"},
        FLL: {lat:26.0726, lon:-80.1527, name:"Fort Lauderdale"},
        SLC: {lat:40.7884, lon:-111.9778, name:"Salt Lake City"},
        DCA: {lat:38.8512, lon:-77.0402, name:"Washington Reagan"},
        IAD: {lat:38.9531, lon:-77.4565, name:"Washington Dulles"},
        SAN: {lat:32.7338, lon:-117.1933, name:"San Diego"},
        TPA: {lat:27.9755, lon:-82.5332, name:"Tampa"},
        BWI: {lat:39.1774, lon:-76.6684, name:"Baltimore"},
        MDW: {lat:41.7868, lon:-87.7522, name:"Chicago Midway"},
        HNL: {lat:21.3187, lon:-157.9224, name:"Honolulu"},
        ANC: {lat:61.1744, lon:-149.9961, name:"Anchorage"},
        STL: {lat:38.7487, lon:-90.3700, name:"St Louis"},
        AUS: {lat:30.1945, lon:-97.6699, name:"Austin"},
        BNA: {lat:36.1245, lon:-86.6782, name:"Nashville"},
        MCI: {lat:39.2976, lon:-94.7139, name:"Kansas City"},
        IND: {lat:39.7173, lon:-86.2944, name:"Indianapolis"},
        PDX: {lat:45.5887, lon:-122.5975, name:"Portland"},
        CLE: {lat:41.4117, lon:-81.8498, name:"Cleveland"},
        CVG: {lat:39.0488, lon:-84.6678, name:"Cincinnati"},
        PIT: {lat:40.4915, lon:-80.2329, name:"Pittsburgh"},
        RDU: {lat:35.8776, lon:-78.7875, name:"Raleigh-Durham"},

        // North America — Canada
        YYZ: {lat:43.6777, lon:-79.6248, name:"Toronto Pearson"},
        YVR: {lat:49.1967, lon:-123.1815, name:"Vancouver"},
        YUL: {lat:45.4706, lon:-73.7408, name:"Montreal"},
        YYC: {lat:51.1215, lon:-114.0076, name:"Calgary"},
        YEG: {lat:53.3097, lon:-113.5801, name:"Edmonton"},
        YOW: {lat:45.3225, lon:-75.6692, name:"Ottawa"},
        YHZ: {lat:44.8808, lon:-63.5086, name:"Halifax"},
        YWG: {lat:49.9100, lon:-97.2399, name:"Winnipeg"},

        // North America — Mexico / Caribbean
        MEX: {lat:19.4361, lon:-99.0719, name:"Mexico City"},
        CUN: {lat:21.0365, lon:-86.8771, name:"Cancún"},
        GDL: {lat:20.5218, lon:-103.3111, name:"Guadalajara"},
        MTY: {lat:25.7785, lon:-100.1067, name:"Monterrey"},
        SJU: {lat:18.4393, lon:-66.0018, name:"San Juan"},
        HAV: {lat:22.9892, lon:-82.4091, name:"Havana"},
        NAS: {lat:25.0389, lon:-77.4661, name:"Nassau"},
        SDQ: {lat:18.4297, lon:-69.6689, name:"Santo Domingo"},
        KIN: {lat:17.9356, lon:-76.7875, name:"Kingston"},

        // South America
        GRU: {lat:-23.4356, lon:-46.4731, name:"São Paulo Guarulhos"},
        GIG: {lat:-22.8089, lon:-43.2436, name:"Rio de Janeiro Galeão"},
        BSB: {lat:-15.8697, lon:-47.9208, name:"Brasília"},
        EZE: {lat:-34.8222, lon:-58.5358, name:"Buenos Aires Ezeiza"},
        SCL: {lat:-33.3930, lon:-70.7858, name:"Santiago"},
        LIM: {lat:-12.0219, lon:-77.1143, name:"Lima"},
        BOG: {lat:4.7016, lon:-74.1469, name:"Bogotá"},
        UIO: {lat:-0.1292, lon:-78.3575, name:"Quito"},
        CCS: {lat:10.6013, lon:-66.9911, name:"Caracas"},
        PTY: {lat:9.0714, lon:-79.3835, name:"Panama City"},
        SJO: {lat:9.9939, lon:-84.2089, name:"San José CR"},
        MVD: {lat:-34.8384, lon:-56.0308, name:"Montevideo"},
        ASU: {lat:-25.2399, lon:-57.5191, name:"Asunción"},
        VVI: {lat:-17.6448, lon:-63.1354, name:"Santa Cruz"},

        // Europe — Western
        LHR: {lat:51.4700, lon:-0.4543, name:"London Heathrow"},
        LGW: {lat:51.1481, lon:-0.1903, name:"London Gatwick"},
        STN: {lat:51.8860, lon:0.2389, name:"London Stansted"},
        LTN: {lat:51.8747, lon:-0.3683, name:"London Luton"},
        CDG: {lat:49.0097, lon:2.5479, name:"Paris Charles de Gaulle"},
        ORY: {lat:48.7233, lon:2.3794, name:"Paris Orly"},
        AMS: {lat:52.3105, lon:4.7683, name:"Amsterdam Schiphol"},
        FRA: {lat:50.0379, lon:8.5622, name:"Frankfurt"},
        MUC: {lat:48.3537, lon:11.7860, name:"Munich"},
        TXL: {lat:52.5597, lon:13.2877, name:"Berlin Tegel"},
        BER: {lat:52.3667, lon:13.5033, name:"Berlin Brandenburg"},
        DUS: {lat:51.2895, lon:6.7668, name:"Düsseldorf"},
        HAM: {lat:53.6304, lon:9.9882, name:"Hamburg"},
        STR: {lat:48.6900, lon:9.2219, name:"Stuttgart"},
        CGN: {lat:50.8659, lon:7.1428, name:"Cologne/Bonn"},
        BRU: {lat:50.9014, lon:4.4844, name:"Brussels"},
        ZRH: {lat:47.4647, lon:8.5492, name:"Zürich"},
        GVA: {lat:46.2381, lon:6.1090, name:"Geneva"},
        VIE: {lat:48.1103, lon:16.5697, name:"Vienna"},
        DUB: {lat:53.4213, lon:-6.2701, name:"Dublin"},
        LIS: {lat:38.7813, lon:-9.1359, name:"Lisbon"},
        OPO: {lat:41.2481, lon:-8.6814, name:"Porto"},
        MAD: {lat:40.4983, lon:-3.5676, name:"Madrid Barajas"},
        BCN: {lat:41.2974, lon:2.0833, name:"Barcelona"},
        AGP: {lat:36.6749, lon:-4.4991, name:"Málaga"},
        VLC: {lat:39.4893, lon:-0.4816, name:"Valencia"},
        PMI: {lat:39.5517, lon:2.7388, name:"Palma de Mallorca"},
        FCO: {lat:41.8003, lon:12.2389, name:"Rome Fiumicino"},
        MXP: {lat:45.6306, lon:8.7281, name:"Milan Malpensa"},
        LIN: {lat:45.4451, lon:9.2767, name:"Milan Linate"},
        VCE: {lat:45.5053, lon:12.3519, name:"Venice"},
        NAP: {lat:40.8861, lon:14.2908, name:"Naples"},
        BLQ: {lat:44.5354, lon:11.2887, name:"Bologna"},
        ATH: {lat:37.9364, lon:23.9445, name:"Athens"},

        // Europe — Northern
        ARN: {lat:59.6519, lon:17.9186, name:"Stockholm Arlanda"},
        CPH: {lat:55.6181, lon:12.6561, name:"Copenhagen"},
        OSL: {lat:60.1976, lon:11.1004, name:"Oslo"},
        HEL: {lat:60.3172, lon:24.9633, name:"Helsinki"},
        KEF: {lat:63.9850, lon:-22.6056, name:"Reykjavík Keflavík"},
        BGO: {lat:60.2934, lon:5.2181, name:"Bergen"},
        GOT: {lat:57.6628, lon:12.2798, name:"Gothenburg"},
        TRD: {lat:63.4578, lon:10.9239, name:"Trondheim"},
        SVG: {lat:58.8767, lon:5.6378, name:"Stavanger"},
        BLL: {lat:55.7403, lon:9.1518, name:"Billund"},

        // Europe — Eastern
        SVO: {lat:55.9726, lon:37.4146, name:"Moscow Sheremetyevo"},
        DME: {lat:55.4088, lon:37.9063, name:"Moscow Domodedovo"},
        VKO: {lat:55.5915, lon:37.2615, name:"Moscow Vnukovo"},
        LED: {lat:59.8003, lon:30.2625, name:"St Petersburg"},
        KBP: {lat:50.3450, lon:30.8947, name:"Kyiv Boryspil"},
        WAW: {lat:52.1657, lon:20.9671, name:"Warsaw Chopin"},
        KRK: {lat:50.0777, lon:19.7848, name:"Kraków"},
        PRG: {lat:50.1008, lon:14.2632, name:"Prague"},
        BUD: {lat:47.4369, lon:19.2556, name:"Budapest"},
        OTP: {lat:44.5722, lon:26.1022, name:"Bucharest"},
        SOF: {lat:42.6967, lon:23.4114, name:"Sofia"},
        BEG: {lat:44.8184, lon:20.3091, name:"Belgrade"},
        ZAG: {lat:45.7429, lon:16.0688, name:"Zagreb"},
        LJU: {lat:46.2237, lon:14.4576, name:"Ljubljana"},
        RIX: {lat:56.9236, lon:23.9711, name:"Riga"},
        VNO: {lat:54.6341, lon:25.2858, name:"Vilnius"},
        TLL: {lat:59.4133, lon:24.8328, name:"Tallinn"},

        // Europe — Turkey/Cyprus
        IST: {lat:41.2611, lon:28.7411, name:"Istanbul"},
        SAW: {lat:40.8986, lon:29.3092, name:"Istanbul Sabiha Gökçen"},
        ESB: {lat:40.1281, lon:32.9951, name:"Ankara"},
        AYT: {lat:36.8987, lon:30.8005, name:"Antalya"},
        ADB: {lat:38.2924, lon:27.1570, name:"İzmir"},
        LCA: {lat:34.8751, lon:33.6249, name:"Larnaca"},

        // Middle East
        DXB: {lat:25.2532, lon:55.3657, name:"Dubai"},
        DWC: {lat:24.8967, lon:55.1614, name:"Dubai World Central"},
        AUH: {lat:24.4330, lon:54.6511, name:"Abu Dhabi"},
        DOH: {lat:25.2731, lon:51.6080, name:"Doha"},
        RUH: {lat:24.9576, lon:46.6988, name:"Riyadh"},
        JED: {lat:21.6796, lon:39.1565, name:"Jeddah"},
        DMM: {lat:26.4712, lon:49.7979, name:"Dammam"},
        KWI: {lat:29.2266, lon:47.9689, name:"Kuwait"},
        BAH: {lat:26.2708, lon:50.6336, name:"Bahrain"},
        MCT: {lat:23.5933, lon:58.2844, name:"Muscat"},
        TLV: {lat:32.0114, lon:34.8867, name:"Tel Aviv"},
        AMM: {lat:31.7226, lon:35.9933, name:"Amman"},
        BEY: {lat:33.8209, lon:35.4884, name:"Beirut"},
        IKA: {lat:35.4161, lon:51.1522, name:"Tehran Imam Khomeini"},

        // Africa
        CAI: {lat:30.1219, lon:31.4056, name:"Cairo"},
        JNB: {lat:-26.1392, lon:28.2460, name:"Johannesburg"},
        CPT: {lat:-33.9648, lon:18.6017, name:"Cape Town"},
        DUR: {lat:-29.6144, lon:31.1197, name:"Durban"},
        NBO: {lat:-1.3192, lon:36.9278, name:"Nairobi"},
        ADD: {lat:8.9779, lon:38.7993, name:"Addis Ababa"},
        LOS: {lat:6.5774, lon:3.3214, name:"Lagos"},
        ABV: {lat:9.0067, lon:7.2632, name:"Abuja"},
        ACC: {lat:5.6052, lon:-0.1668, name:"Accra"},
        DKR: {lat:14.6709, lon:-17.0734, name:"Dakar"},
        CAS: {lat:33.3675, lon:-7.5898, name:"Casablanca"},
        RAK: {lat:31.6069, lon:-8.0363, name:"Marrakesh"},
        TUN: {lat:36.8510, lon:10.2272, name:"Tunis"},
        ALG: {lat:36.6911, lon:3.2154, name:"Algiers"},
        DAR: {lat:-6.8781, lon:39.2026, name:"Dar es Salaam"},

        // Asia — South
        BOM: {lat:19.0887, lon:72.8679, name:"Mumbai"},
        DEL: {lat:28.5562, lon:77.1000, name:"Delhi"},
        BLR: {lat:13.1986, lon:77.7066, name:"Bengaluru"},
        MAA: {lat:12.9941, lon:80.1709, name:"Chennai"},
        HYD: {lat:17.2403, lon:78.4294, name:"Hyderabad"},
        CCU: {lat:22.6547, lon:88.4467, name:"Kolkata"},
        COK: {lat:10.1520, lon:76.4019, name:"Kochi"},
        AMD: {lat:23.0772, lon:72.6347, name:"Ahmedabad"},
        GOI: {lat:15.3808, lon:73.8314, name:"Goa"},
        CMB: {lat:7.1808, lon:79.8842, name:"Colombo"},
        MLE: {lat:4.1918, lon:73.5291, name:"Malé"},
        KTM: {lat:27.6966, lon:85.3591, name:"Kathmandu"},
        DAC: {lat:23.8433, lon:90.3978, name:"Dhaka"},
        ISB: {lat:33.5491, lon:72.8258, name:"Islamabad"},
        KHI: {lat:24.9065, lon:67.1608, name:"Karachi"},
        LHE: {lat:31.5216, lon:74.4036, name:"Lahore"},

        // Asia — East
        PEK: {lat:40.0801, lon:116.5846, name:"Beijing Capital"},
        PKX: {lat:39.5098, lon:116.4106, name:"Beijing Daxing"},
        PVG: {lat:31.1443, lon:121.8083, name:"Shanghai Pudong"},
        SHA: {lat:31.1979, lon:121.3364, name:"Shanghai Hongqiao"},
        CAN: {lat:23.3924, lon:113.2988, name:"Guangzhou"},
        SZX: {lat:22.6393, lon:113.8108, name:"Shenzhen"},
        CTU: {lat:30.5785, lon:103.9471, name:"Chengdu"},
        XIY: {lat:34.4471, lon:108.7516, name:"Xi'an"},
        KMG: {lat:25.1019, lon:102.9292, name:"Kunming"},
        HGH: {lat:30.2295, lon:120.4344, name:"Hangzhou"},
        WUH: {lat:30.7838, lon:114.2081, name:"Wuhan"},
        CKG: {lat:29.7193, lon:106.6417, name:"Chongqing"},
        TAO: {lat:36.2661, lon:120.3744, name:"Qingdao"},
        DLC: {lat:38.9657, lon:121.5386, name:"Dalian"},
        HKG: {lat:22.3080, lon:113.9185, name:"Hong Kong"},
        MFM: {lat:22.1496, lon:113.5915, name:"Macau"},
        TPE: {lat:25.0777, lon:121.2328, name:"Taipei Taoyuan"},
        TSA: {lat:25.0697, lon:121.5519, name:"Taipei Songshan"},
        ICN: {lat:37.4602, lon:126.4407, name:"Seoul Incheon"},
        GMP: {lat:37.5586, lon:126.7942, name:"Seoul Gimpo"},
        PUS: {lat:35.1795, lon:128.9382, name:"Busan"},
        NRT: {lat:35.7647, lon:140.3864, name:"Tokyo Narita"},
        HND: {lat:35.5494, lon:139.7798, name:"Tokyo Haneda"},
        KIX: {lat:34.4347, lon:135.2440, name:"Osaka Kansai"},
        ITM: {lat:34.7855, lon:135.4382, name:"Osaka Itami"},
        NGO: {lat:34.8584, lon:136.8054, name:"Nagoya"},
        FUK: {lat:33.5859, lon:130.4509, name:"Fukuoka"},
        CTS: {lat:42.7752, lon:141.6923, name:"Sapporo Chitose"},
        OKA: {lat:26.1958, lon:127.6458, name:"Okinawa"},

        // Asia — Southeast
        SIN: {lat:1.3644, lon:103.9915, name:"Singapore Changi"},
        KUL: {lat:2.7456, lon:101.7099, name:"Kuala Lumpur"},
        BKI: {lat:5.9372, lon:116.0510, name:"Kota Kinabalu"},
        PEN: {lat:5.2971, lon:100.2766, name:"Penang"},
        BKK: {lat:13.6900, lon:100.7501, name:"Bangkok Suvarnabhumi"},
        DMK: {lat:13.9126, lon:100.6068, name:"Bangkok Don Mueang"},
        HKT: {lat:8.1132, lon:98.3169, name:"Phuket"},
        CNX: {lat:18.7668, lon:98.9628, name:"Chiang Mai"},
        CGK: {lat:-6.1256, lon:106.6559, name:"Jakarta"},
        DPS: {lat:-8.7484, lon:115.1671, name:"Denpasar Bali"},
        SUB: {lat:-7.3798, lon:112.7867, name:"Surabaya"},
        MNL: {lat:14.5086, lon:121.0194, name:"Manila"},
        CEB: {lat:10.3075, lon:123.9794, name:"Cebu"},
        SGN: {lat:10.8188, lon:106.6519, name:"Ho Chi Minh City"},
        HAN: {lat:21.2212, lon:105.8071, name:"Hanoi"},
        DAD: {lat:16.0439, lon:108.1994, name:"Da Nang"},
        PNH: {lat:11.5466, lon:104.8441, name:"Phnom Penh"},
        REP: {lat:13.4108, lon:103.8128, name:"Siem Reap"},
        VTE: {lat:17.9883, lon:102.5635, name:"Vientiane"},
        RGN: {lat:16.9073, lon:96.1332, name:"Yangon"},
        BWN: {lat:4.9442, lon:114.9285, name:"Bandar Seri Begawan"},

        // Asia — Central
        TAS: {lat:41.2579, lon:69.2811, name:"Tashkent"},
        ALA: {lat:43.3521, lon:77.0405, name:"Almaty"},
        NQZ: {lat:51.0222, lon:71.4669, name:"Astana"},
        GYD: {lat:40.4675, lon:50.0467, name:"Baku"},
        EVN: {lat:40.1473, lon:44.3959, name:"Yerevan"},
        TBS: {lat:41.6692, lon:44.9547, name:"Tbilisi"},

        // Oceania
        SYD: {lat:-33.9399, lon:151.1753, name:"Sydney"},
        MEL: {lat:-37.6690, lon:144.8410, name:"Melbourne"},
        BNE: {lat:-27.3942, lon:153.1218, name:"Brisbane"},
        PER: {lat:-31.9385, lon:115.9672, name:"Perth"},
        ADL: {lat:-34.9450, lon:138.5306, name:"Adelaide"},
        OOL: {lat:-28.1644, lon:153.5050, name:"Gold Coast"},
        CNS: {lat:-16.8858, lon:145.7551, name:"Cairns"},
        DRW: {lat:-12.4083, lon:130.8729, name:"Darwin"},
        AKL: {lat:-37.0082, lon:174.7917, name:"Auckland"},
        WLG: {lat:-41.3272, lon:174.8053, name:"Wellington"},
        CHC: {lat:-43.4894, lon:172.5320, name:"Christchurch"},
        NAN: {lat:-17.7554, lon:177.4434, name:"Nadi"},
        PPT: {lat:-17.5535, lon:-149.6066, name:"Papeete"}
    }

    const ALIASES = {
        // Common alternative codes seen in AS — map to the canonical entry.
        TYO: COORDS.HND,
        LON: COORDS.LHR,
        PAR: COORDS.CDG,
        NYC: COORDS.JFK,
        CHI: COORDS.ORD,
        WAS: COORDS.DCA,
        MIL: COORDS.MXP,
        ROM: COORDS.FCO,
        BUE: COORDS.EZE,
        SAO: COORDS.GRU,
        RIO: COORDS.GIG,
        BJS: COORDS.PEK,
        SHA_: COORDS.PVG,
        SEL: COORDS.ICN,
        OSA: COORDS.KIX,
        BER_: COORDS.BER,
        STO: COORDS.ARN
    }

    const WorldViewAirportCoords = {
        get(iata) {
            if (typeof iata !== "string") return null
            const code = iata.toUpperCase()
            if (COORDS[code]) return COORDS[code]
            if (ALIASES[code]) return ALIASES[code]
            return null
        },
        has(iata) { return !!this.get(iata) },
        size() { return Object.keys(COORDS).length },

        /**
         * Equirectangular projection of (lat, lon) into a [0..1] × [0..1]
         * unit square, with x going east and y going south. Callers
         * multiply by their own pixel canvas dimensions.
         */
        project(lat, lon) {
            const x = (Number(lon) + 180) / 360
            const y = (90 - Number(lat)) / 180
            return {x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y))}
        }
    }

    if (typeof window !== "undefined") {
        window.WorldViewAirportCoords = WorldViewAirportCoords
    }
})()
