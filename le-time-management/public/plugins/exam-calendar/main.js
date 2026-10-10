/* U-Time 插件：考试日历（exam-calendar）
 * ⚠ 这个文件是构建产物，不要直接改。改 src/main.template.js + src/exam-data.json，
 *   然后在仓库根跑：node tools/build-exam-calendar-plugin.js
 *
 * 数据来源：exam-collector 采集的官方公告（每条带 confirmed 与 source.url）
 * 宿主契约：见 https://momoqiqi-qwq.github.io/U-Time/ 与源码 le-time-management/src/pluginHost.js
 */
(function () {
  "use strict";

  const DATA = {
    "schema": "exam-calendar-data/1",
    "generatedAt": "2026-09-10T11:24:10.555Z",
    "collectedForDate": "2026-09-10",
    "scope": "大学生专用国家级考试；官方公告采集，非实时数据",
    "stats": {
      "total": 80,
      "confirmed": 71,
      "estimated": 9,
      "mergedTicketRows": 10
    },
    "events": [
      {
        "examId": "tem4",
        "name": "英语专业四级考试（TEM4）",
        "type": "written",
        "typeName": "笔试",
        "category": "英语专业",
        "date": "2022-10-30",
        "endDate": "2022-10-30",
        "confirmed": true,
        "url": "http://tem.fltonline.cn/?p=75440",
        "publishedAt": "2021-11-24",
        "cycle": 2022,
        "startTime": "8:30",
        "endTime": "10:40"
      },
      {
        "examId": "tem8",
        "name": "英语专业八级考试（TEM8）",
        "type": "written",
        "typeName": "笔试",
        "category": "英语专业",
        "date": "2022-11-19",
        "endDate": "2022-11-19",
        "confirmed": true,
        "url": "http://tem.fltonline.cn/?p=75440",
        "publishedAt": "2021-11-24",
        "cycle": 2022,
        "startTime": "8:30",
        "endTime": "11:00"
      },
      {
        "examId": "ncre",
        "name": "全国计算机等级考试（NCRE）",
        "type": "written",
        "typeName": "笔试",
        "category": "计算机",
        "date": "2023-03-25",
        "endDate": "2023-03-27",
        "confirmed": true,
        "url": "https://ncre.neea.edu.cn/html1/report/2302/226-1.htm",
        "publishedAt": "2023-02-15",
        "cycle": 2023
      },
      {
        "examId": "tem8",
        "name": "英语专业八级考试（TEM8）",
        "type": "written",
        "typeName": "笔试",
        "category": "英语专业",
        "date": "2023-04-22",
        "endDate": "2023-04-22",
        "confirmed": true,
        "url": "http://tem.fltonline.cn/?p=75508",
        "publishedAt": "2023-02-15",
        "cycle": 2023,
        "startTime": "8:30",
        "endTime": "11:00"
      },
      {
        "examId": "cet-set4",
        "name": "英语四级口语考试（CET-SET4）",
        "type": "oral",
        "typeName": "口试",
        "category": "外语",
        "date": "2023-05-20",
        "endDate": "2023-05-20",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2303/329-1.htm",
        "publishedAt": "2023-03-27",
        "cycle": 2023
      },
      {
        "examId": "cet-set6",
        "name": "英语六级口语考试（CET-SET6）",
        "type": "oral",
        "typeName": "口试",
        "category": "外语",
        "date": "2023-05-21",
        "endDate": "2023-05-21",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2303/329-1.htm",
        "publishedAt": "2023-03-27",
        "cycle": 2023
      },
      {
        "examId": "ncre",
        "name": "全国计算机等级考试（NCRE）",
        "type": "written",
        "typeName": "笔试",
        "category": "计算机",
        "date": "2023-05-27",
        "endDate": "2023-05-28",
        "confirmed": true,
        "url": "https://ncre.neea.edu.cn/html1/report/2302/226-1.htm",
        "publishedAt": "2023-02-15",
        "cycle": 2023
      },
      {
        "examId": "cet4",
        "name": "全国大学英语四级考试（CET4）",
        "type": "written",
        "typeName": "笔试",
        "category": "外语",
        "date": "2023-06-17",
        "endDate": "2023-06-17",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2303/329-1.htm",
        "publishedAt": "2023-03-27",
        "cycle": 2023
      },
      {
        "examId": "cet6",
        "name": "全国大学英语六级考试（CET6）",
        "type": "written",
        "typeName": "笔试",
        "category": "外语",
        "date": "2023-06-17",
        "endDate": "2023-06-17",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2303/329-1.htm",
        "publishedAt": "2023-03-27",
        "cycle": 2023
      },
      {
        "examId": "tem4",
        "name": "英语专业四级考试（TEM4）",
        "type": "written",
        "typeName": "笔试",
        "category": "英语专业",
        "date": "2023-06-18",
        "endDate": "2023-06-18",
        "confirmed": true,
        "url": "http://tem.fltonline.cn/?p=75508",
        "publishedAt": "2023-02-15",
        "cycle": 2023,
        "startTime": "8:30",
        "endTime": "10:40"
      },
      {
        "examId": "ncre",
        "name": "全国计算机等级考试（NCRE）",
        "type": "written",
        "typeName": "笔试",
        "category": "计算机",
        "date": "2023-09-23",
        "endDate": "2023-09-25",
        "confirmed": true,
        "url": "https://ncre.neea.edu.cn/html1/report/2306/333-1.htm",
        "publishedAt": "2023-06-19",
        "cycle": 2023
      },
      {
        "examId": "cet-set4",
        "name": "英语四级口语考试（CET-SET4）",
        "type": "oral",
        "typeName": "口试",
        "category": "外语",
        "date": "2023-11-18",
        "endDate": "2023-11-18",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2309/7-1.htm",
        "publishedAt": "2023-09-01",
        "cycle": 2023
      },
      {
        "examId": "cet-set6",
        "name": "英语六级口语考试（CET-SET6）",
        "type": "oral",
        "typeName": "口试",
        "category": "外语",
        "date": "2023-11-19",
        "endDate": "2023-11-19",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2309/7-1.htm",
        "publishedAt": "2023-09-01",
        "cycle": 2023
      },
      {
        "examId": "ncre",
        "name": "全国计算机等级考试（NCRE）",
        "type": "written",
        "typeName": "笔试",
        "category": "计算机",
        "date": "2023-12-02",
        "endDate": "2023-12-03",
        "confirmed": true,
        "url": "https://ncre.neea.edu.cn/html1/report/2302/226-1.htm",
        "publishedAt": "2023-02-15",
        "cycle": 2023
      },
      {
        "examId": "cet4",
        "name": "全国大学英语四级考试（CET4）",
        "type": "written",
        "typeName": "笔试",
        "category": "外语",
        "date": "2023-12-16",
        "endDate": "2023-12-16",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2309/7-1.htm",
        "publishedAt": "2023-09-01",
        "cycle": 2023
      },
      {
        "examId": "cet6",
        "name": "全国大学英语六级考试（CET6）",
        "type": "written",
        "typeName": "笔试",
        "category": "外语",
        "date": "2023-12-16",
        "endDate": "2023-12-16",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2309/7-1.htm",
        "publishedAt": "2023-09-01",
        "cycle": 2023
      },
      {
        "examId": "ncre",
        "name": "全国计算机等级考试（NCRE）",
        "type": "written",
        "typeName": "笔试",
        "category": "计算机",
        "date": "2024-03-23",
        "endDate": "2024-03-25",
        "confirmed": true,
        "url": "https://ncre.neea.edu.cn/html1/report/2312/255-1.htm",
        "publishedAt": "2023-12-28",
        "cycle": 2024
      },
      {
        "examId": "tem8",
        "name": "英语专业八级考试（TEM8）",
        "type": "written",
        "typeName": "笔试",
        "category": "英语专业",
        "date": "2024-04-13",
        "endDate": "2024-04-13",
        "confirmed": true,
        "url": "http://tem.fltonline.cn/?p=75519",
        "publishedAt": "2023-11-13",
        "cycle": 2024,
        "startTime": "8:30",
        "endTime": "11:00"
      },
      {
        "examId": "cet-set4",
        "name": "英语四级口语考试（CET-SET4）",
        "type": "oral",
        "typeName": "口试",
        "category": "外语",
        "date": "2024-05-18",
        "endDate": "2024-05-18",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2403/75-1.htm",
        "publishedAt": "2024-03-08",
        "cycle": 2024
      },
      {
        "examId": "cet-set6",
        "name": "英语六级口语考试（CET-SET6）",
        "type": "oral",
        "typeName": "口试",
        "category": "外语",
        "date": "2024-05-19",
        "endDate": "2024-05-19",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2403/75-1.htm",
        "publishedAt": "2024-03-08",
        "cycle": 2024
      },
      {
        "examId": "cet4",
        "name": "全国大学英语四级考试（CET4）",
        "type": "written",
        "typeName": "笔试",
        "category": "外语",
        "date": "2024-06-15",
        "endDate": "2024-06-15",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2403/75-1.htm",
        "publishedAt": "2024-03-08",
        "cycle": 2024,
        "startTime": "9:00",
        "endTime": "11:20"
      },
      {
        "examId": "cet6",
        "name": "全国大学英语六级考试（CET6）",
        "type": "written",
        "typeName": "笔试",
        "category": "外语",
        "date": "2024-06-15",
        "endDate": "2024-06-15",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2403/75-1.htm",
        "publishedAt": "2024-03-08",
        "cycle": 2024,
        "startTime": "15:00",
        "endTime": "17:25"
      },
      {
        "examId": "tem4",
        "name": "英语专业四级考试（TEM4）",
        "type": "written",
        "typeName": "笔试",
        "category": "英语专业",
        "date": "2024-06-16",
        "endDate": "2024-06-16",
        "confirmed": true,
        "url": "http://tem.fltonline.cn/?p=75519",
        "publishedAt": "2023-11-13",
        "cycle": 2024,
        "startTime": "8:30",
        "endTime": "10:40"
      },
      {
        "examId": "ncre",
        "name": "全国计算机等级考试（NCRE）",
        "type": "written",
        "typeName": "笔试",
        "category": "计算机",
        "date": "2024-09-21",
        "endDate": "2024-09-23",
        "confirmed": true,
        "url": "https://ncre.neea.edu.cn/html1/report/2406/444-1.htm",
        "publishedAt": "2024-06-25",
        "cycle": 2024
      },
      {
        "examId": "tem8",
        "name": "英语专业八级考试（TEM8）",
        "type": "registration",
        "typeName": "报名",
        "category": "英语专业",
        "date": "2024-11-11",
        "endDate": "2024-12-10",
        "confirmed": true,
        "url": "http://tem.fltonline.cn/?p=75527",
        "publishedAt": "2024-11-15",
        "cycle": 2024
      },
      {
        "examId": "2024-11-12|大学英语四六级口试",
        "name": "大学英语四六级口试准考证打印",
        "type": "ticket-print",
        "typeName": "准考证打印",
        "category": "外语",
        "date": "2024-11-12",
        "endDate": "2024-11-12",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2409/8-1.htm",
        "publishedAt": "2024-09-05",
        "cycle": 2024,
        "mergedFrom": [
          "cet-set4",
          "cet-set6"
        ]
      },
      {
        "examId": "cet-set4",
        "name": "英语四级口语考试（CET-SET4）",
        "type": "oral",
        "typeName": "口试",
        "category": "外语",
        "date": "2024-11-23",
        "endDate": "2024-11-23",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2409/8-1.htm",
        "publishedAt": "2024-09-05",
        "cycle": 2024
      },
      {
        "examId": "cet-set6",
        "name": "英语六级口语考试（CET-SET6）",
        "type": "oral",
        "typeName": "口试",
        "category": "外语",
        "date": "2024-11-24",
        "endDate": "2024-11-24",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2409/8-1.htm",
        "publishedAt": "2024-09-05",
        "cycle": 2024
      },
      {
        "examId": "2024-12-06|大学英语四六级笔试",
        "name": "大学英语四六级笔试准考证打印",
        "type": "ticket-print",
        "typeName": "准考证打印",
        "category": "外语",
        "date": "2024-12-06",
        "endDate": "2024-12-06",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2409/8-1.htm",
        "publishedAt": "2024-09-05",
        "cycle": 2024,
        "mergedFrom": [
          "cet4",
          "cet6"
        ]
      },
      {
        "examId": "cet4",
        "name": "全国大学英语四级考试（CET4）",
        "type": "written",
        "typeName": "笔试",
        "category": "外语",
        "date": "2024-12-14",
        "endDate": "2024-12-14",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2409/8-1.htm",
        "publishedAt": "2024-09-05",
        "cycle": 2024
      },
      {
        "examId": "cet6",
        "name": "全国大学英语六级考试（CET6）",
        "type": "written",
        "typeName": "笔试",
        "category": "外语",
        "date": "2024-12-14",
        "endDate": "2024-12-14",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2409/8-1.htm",
        "publishedAt": "2024-09-05",
        "cycle": 2024
      },
      {
        "examId": "ncre",
        "name": "全国计算机等级考试（NCRE）",
        "type": "written",
        "typeName": "笔试",
        "category": "计算机",
        "date": "2025-03-29",
        "endDate": "2025-03-31",
        "confirmed": true,
        "url": "https://ncre.neea.edu.cn/html1/report/2412/138-1.htm",
        "publishedAt": "2024-12-25",
        "cycle": 2025
      },
      {
        "examId": "tem8",
        "name": "英语专业八级考试（TEM8）",
        "type": "written",
        "typeName": "笔试",
        "category": "英语专业",
        "date": "2025-03-29",
        "endDate": "2025-03-29",
        "confirmed": true,
        "url": "http://tem.fltonline.cn/?p=75527",
        "publishedAt": "2024-11-15",
        "cycle": 2025,
        "startTime": "8:30",
        "endTime": "11:00"
      },
      {
        "examId": "2025-05-20|大学英语四六级口试",
        "name": "大学英语四六级口试准考证打印",
        "type": "ticket-print",
        "typeName": "准考证打印",
        "category": "外语",
        "date": "2025-05-20",
        "endDate": "2025-05-20",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2503/19-1.htm",
        "publishedAt": "2025-03-07",
        "cycle": 2025,
        "mergedFrom": [
          "cet-set4",
          "cet-set6"
        ]
      },
      {
        "examId": "cet-set4",
        "name": "英语四级口语考试（CET-SET4）",
        "type": "oral",
        "typeName": "口试",
        "category": "外语",
        "date": "2025-05-24",
        "endDate": "2025-05-24",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2503/19-1.htm",
        "publishedAt": "2025-03-07",
        "cycle": 2025
      },
      {
        "examId": "cet-set6",
        "name": "英语六级口语考试（CET-SET6）",
        "type": "oral",
        "typeName": "口试",
        "category": "外语",
        "date": "2025-05-25",
        "endDate": "2025-05-25",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2503/19-1.htm",
        "publishedAt": "2025-03-07",
        "cycle": 2025
      },
      {
        "examId": "2025-06-06|大学英语四六级笔试",
        "name": "大学英语四六级笔试准考证打印",
        "type": "ticket-print",
        "typeName": "准考证打印",
        "category": "外语",
        "date": "2025-06-06",
        "endDate": "2025-06-06",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2503/19-1.htm",
        "publishedAt": "2025-03-07",
        "cycle": 2025,
        "mergedFrom": [
          "cet4",
          "cet6"
        ]
      },
      {
        "examId": "cet4",
        "name": "全国大学英语四级考试（CET4）",
        "type": "written",
        "typeName": "笔试",
        "category": "外语",
        "date": "2025-06-14",
        "endDate": "2025-06-14",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2503/19-1.htm",
        "publishedAt": "2025-03-07",
        "cycle": 2025,
        "startTime": "9:00",
        "endTime": "11:20"
      },
      {
        "examId": "cet6",
        "name": "全国大学英语六级考试（CET6）",
        "type": "written",
        "typeName": "笔试",
        "category": "外语",
        "date": "2025-06-14",
        "endDate": "2025-06-14",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2503/19-1.htm",
        "publishedAt": "2025-03-07",
        "cycle": 2025,
        "startTime": "15:00",
        "endTime": "17:25"
      },
      {
        "examId": "tem4",
        "name": "英语专业四级考试（TEM4）",
        "type": "written",
        "typeName": "笔试",
        "category": "英语专业",
        "date": "2025-06-15",
        "endDate": "2025-06-15",
        "confirmed": true,
        "url": "http://tem.fltonline.cn/?p=75527",
        "publishedAt": "2024-11-15",
        "cycle": 2025,
        "startTime": "8:30",
        "endTime": "10:40"
      },
      {
        "examId": "ncre",
        "name": "全国计算机等级考试（NCRE）",
        "type": "written",
        "typeName": "笔试",
        "category": "计算机",
        "date": "2025-09-20",
        "endDate": "2025-09-22",
        "confirmed": true,
        "url": "https://ncre.neea.edu.cn/html1/report/2506/16-1.htm",
        "publishedAt": "2025-06-25",
        "cycle": 2025
      },
      {
        "examId": "kaoyan",
        "name": "全国硕士研究生招生考试（初试）",
        "type": "pre-registration",
        "typeName": "预报名",
        "category": "升学",
        "date": "2025-10-10",
        "endDate": "2025-10-13",
        "confirmed": true,
        "url": "https://yz.chsi.com.cn/kyzx/jybzc/202509/20250924/2293432108.html",
        "publishedAt": "2025年09月24日",
        "cycle": 2026
      },
      {
        "examId": "kaoyan",
        "name": "全国硕士研究生招生考试（初试）",
        "type": "registration",
        "typeName": "报名",
        "category": "升学",
        "date": "2025-10-16",
        "endDate": "2025-10-27",
        "confirmed": true,
        "url": "https://yz.chsi.com.cn/kyzx/jybzc/202509/20250924/2293432108.html",
        "publishedAt": "2025年09月24日",
        "cycle": 2026
      },
      {
        "examId": "tem8",
        "name": "英语专业八级考试（TEM8）",
        "type": "registration",
        "typeName": "报名",
        "category": "英语专业",
        "date": "2025-11-01",
        "endDate": "2025-12-10",
        "confirmed": true,
        "url": "http://tem.fltonline.cn/?p=75535",
        "publishedAt": "2025-11-07",
        "cycle": 2025
      },
      {
        "examId": "2025-11-18|大学英语四六级口试",
        "name": "大学英语四六级口试准考证打印",
        "type": "ticket-print",
        "typeName": "准考证打印",
        "category": "外语",
        "date": "2025-11-18",
        "endDate": "2025-11-18",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2509/26-1.htm",
        "publishedAt": "2025-09-08",
        "cycle": 2025,
        "mergedFrom": [
          "cet-set4",
          "cet-set6"
        ]
      },
      {
        "examId": "cet-set4",
        "name": "英语四级口语考试（CET-SET4）",
        "type": "oral",
        "typeName": "口试",
        "category": "外语",
        "date": "2025-11-22",
        "endDate": "2025-11-22",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2509/26-1.htm",
        "publishedAt": "2025-09-08",
        "cycle": 2025
      },
      {
        "examId": "cet-set6",
        "name": "英语六级口语考试（CET-SET6）",
        "type": "oral",
        "typeName": "口试",
        "category": "外语",
        "date": "2025-11-23",
        "endDate": "2025-11-23",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2509/26-1.htm",
        "publishedAt": "2025-09-08",
        "cycle": 2025
      },
      {
        "examId": "2025-12-05|大学英语四六级笔试",
        "name": "大学英语四六级笔试准考证打印",
        "type": "ticket-print",
        "typeName": "准考证打印",
        "category": "外语",
        "date": "2025-12-05",
        "endDate": "2025-12-05",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2509/26-1.htm",
        "publishedAt": "2025-09-08",
        "cycle": 2025,
        "mergedFrom": [
          "cet4",
          "cet6"
        ]
      },
      {
        "examId": "cet4",
        "name": "全国大学英语四级考试（CET4）",
        "type": "written",
        "typeName": "笔试",
        "category": "外语",
        "date": "2025-12-13",
        "endDate": "2025-12-13",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2509/26-1.htm",
        "publishedAt": "2025-09-08",
        "cycle": 2025,
        "startTime": "9:00",
        "endTime": "11:20"
      },
      {
        "examId": "cet6",
        "name": "全国大学英语六级考试（CET6）",
        "type": "written",
        "typeName": "笔试",
        "category": "外语",
        "date": "2025-12-13",
        "endDate": "2025-12-13",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2509/26-1.htm",
        "publishedAt": "2025-09-08",
        "cycle": 2025,
        "startTime": "15:00",
        "endTime": "17:25"
      },
      {
        "examId": "kaoyan",
        "name": "全国硕士研究生招生考试（初试）",
        "type": "written",
        "typeName": "笔试",
        "category": "升学",
        "date": "2025-12-20",
        "endDate": "2025-12-21",
        "confirmed": true,
        "url": "https://yz.chsi.com.cn/kyzx/jybzc/202509/20250924/2293432108.html",
        "publishedAt": "2025年09月24日",
        "cycle": 2026
      },
      {
        "examId": "ntce",
        "name": "中小学教师资格考试（NTCE）",
        "type": "written",
        "typeName": "笔试",
        "category": "教师资格",
        "date": "2026-03-07",
        "endDate": "2026-03-07",
        "confirmed": true,
        "url": "https://ntce.neea.cn/xhtml1/folder/1507/1260-1.htm",
        "publishedAt": null,
        "cycle": 2026
      },
      {
        "examId": "tem8",
        "name": "英语专业八级考试（TEM8）",
        "type": "written",
        "typeName": "笔试",
        "category": "英语专业",
        "date": "2026-03-21",
        "endDate": "2026-03-21",
        "confirmed": true,
        "url": "http://tem.fltonline.cn/?p=75535",
        "publishedAt": "2025-11-07",
        "cycle": 2026,
        "startTime": "8:30",
        "endTime": "11:00"
      },
      {
        "examId": "ncre",
        "name": "全国计算机等级考试（NCRE）",
        "type": "written",
        "typeName": "笔试",
        "category": "计算机",
        "date": "2026-03-28",
        "endDate": "2026-03-30",
        "confirmed": true,
        "url": "https://ncre.neea.edu.cn/html1/report/2512/40-1.htm",
        "publishedAt": "2025-12-25",
        "cycle": 2026
      },
      {
        "examId": "ntce",
        "name": "中小学教师资格考试（NTCE）",
        "type": "interview",
        "typeName": "面试",
        "category": "教师资格",
        "date": "2026-05-16",
        "endDate": "2026-05-17",
        "confirmed": true,
        "url": "https://ntce.neea.cn/xhtml1/folder/1507/1260-1.htm",
        "publishedAt": null,
        "cycle": 2026
      },
      {
        "examId": "2026-05-19|大学英语四六级口试",
        "name": "大学英语四六级口试准考证打印",
        "type": "ticket-print",
        "typeName": "准考证打印",
        "category": "外语",
        "date": "2026-05-19",
        "endDate": "2026-05-19",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2603/2-1.htm",
        "publishedAt": "2026-03-06",
        "cycle": 2026,
        "mergedFrom": [
          "cet-set4",
          "cet-set6"
        ]
      },
      {
        "examId": "cet-set4",
        "name": "英语四级口语考试（CET-SET4）",
        "type": "oral",
        "typeName": "口试",
        "category": "外语",
        "date": "2026-05-23",
        "endDate": "2026-05-23",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2603/2-1.htm",
        "publishedAt": "2026-03-06",
        "cycle": 2026
      },
      {
        "examId": "cet-set6",
        "name": "英语六级口语考试（CET-SET6）",
        "type": "oral",
        "typeName": "口试",
        "category": "外语",
        "date": "2026-05-24",
        "endDate": "2026-05-24",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2603/2-1.htm",
        "publishedAt": "2026-03-06",
        "cycle": 2026
      },
      {
        "examId": "2026-06-05|大学英语四六级笔试",
        "name": "大学英语四六级笔试准考证打印",
        "type": "ticket-print",
        "typeName": "准考证打印",
        "category": "外语",
        "date": "2026-06-05",
        "endDate": "2026-06-05",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2603/2-1.htm",
        "publishedAt": "2026-03-06",
        "cycle": 2026,
        "mergedFrom": [
          "cet4",
          "cet6"
        ]
      },
      {
        "examId": "cet4",
        "name": "全国大学英语四级考试（CET4）",
        "type": "written",
        "typeName": "笔试",
        "category": "外语",
        "date": "2026-06-13",
        "endDate": "2026-06-13",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2603/2-1.htm",
        "publishedAt": "2026-03-06",
        "cycle": 2026,
        "startTime": "9:00",
        "endTime": "11:20"
      },
      {
        "examId": "cet6",
        "name": "全国大学英语六级考试（CET6）",
        "type": "written",
        "typeName": "笔试",
        "category": "外语",
        "date": "2026-06-13",
        "endDate": "2026-06-13",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2603/2-1.htm",
        "publishedAt": "2026-03-06",
        "cycle": 2026,
        "startTime": "15:00",
        "endTime": "17:25"
      },
      {
        "examId": "tem4",
        "name": "英语专业四级考试（TEM4）",
        "type": "written",
        "typeName": "笔试",
        "category": "英语专业",
        "date": "2026-06-14",
        "endDate": "2026-06-14",
        "confirmed": true,
        "url": "http://tem.fltonline.cn/?p=75535",
        "publishedAt": "2025-11-07",
        "cycle": 2026,
        "startTime": "8:30",
        "endTime": "10:40"
      },
      {
        "examId": "ntce",
        "name": "中小学教师资格考试（NTCE）",
        "type": "written",
        "typeName": "笔试",
        "category": "教师资格",
        "date": "2026-09-12",
        "endDate": "2026-09-12",
        "confirmed": true,
        "url": "https://ntce.neea.cn/xhtml1/folder/1507/1260-1.htm",
        "publishedAt": null,
        "cycle": 2026
      },
      {
        "examId": "ncre",
        "name": "全国计算机等级考试（NCRE）",
        "type": "written",
        "typeName": "笔试",
        "category": "计算机",
        "date": "2026-09-19",
        "endDate": "2026-09-21",
        "confirmed": true,
        "url": "https://ncre.neea.edu.cn/html1/report/2606/16-1.htm",
        "publishedAt": "2026-06-24",
        "cycle": 2026
      },
      {
        "examId": "2026-11-17|大学英语四六级口试",
        "name": "大学英语四六级口试准考证打印",
        "type": "ticket-print",
        "typeName": "准考证打印",
        "category": "外语",
        "date": "2026-11-17",
        "endDate": "2026-11-17",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2609/1-1.htm",
        "publishedAt": "2026-09-02",
        "cycle": 2026,
        "mergedFrom": [
          "cet-set4",
          "cet-set6"
        ]
      },
      {
        "examId": "cet-set4",
        "name": "英语四级口语考试（CET-SET4）",
        "type": "oral",
        "typeName": "口试",
        "category": "外语",
        "date": "2026-11-21",
        "endDate": "2026-11-21",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2609/1-1.htm",
        "publishedAt": "2026-09-02",
        "cycle": 2026
      },
      {
        "examId": "cet-set6",
        "name": "英语六级口语考试（CET-SET6）",
        "type": "oral",
        "typeName": "口试",
        "category": "外语",
        "date": "2026-11-22",
        "endDate": "2026-11-22",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2609/1-1.htm",
        "publishedAt": "2026-09-02",
        "cycle": 2026
      },
      {
        "examId": "2026-12-01|大学英语四六级笔试",
        "name": "大学英语四六级笔试准考证打印",
        "type": "ticket-print",
        "typeName": "准考证打印",
        "category": "外语",
        "date": "2026-12-01",
        "endDate": "2026-12-01",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2609/1-1.htm",
        "publishedAt": "2026-09-02",
        "cycle": 2026,
        "mergedFrom": [
          "cet4",
          "cet6"
        ]
      },
      {
        "examId": "ntce",
        "name": "中小学教师资格考试（NTCE）",
        "type": "interview",
        "typeName": "面试",
        "category": "教师资格",
        "date": "2026-12-05",
        "endDate": "2026-12-06",
        "confirmed": true,
        "url": "https://ntce.neea.cn/xhtml1/folder/1507/1260-1.htm",
        "publishedAt": null,
        "cycle": 2026
      },
      {
        "examId": "cet4",
        "name": "全国大学英语四级考试（CET4）",
        "type": "written",
        "typeName": "笔试",
        "category": "外语",
        "date": "2026-12-12",
        "endDate": "2026-12-12",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2609/1-1.htm",
        "publishedAt": "2026-09-02",
        "cycle": 2026,
        "startTime": "9:00",
        "endTime": "11:20"
      },
      {
        "examId": "cet6",
        "name": "全国大学英语六级考试（CET6）",
        "type": "written",
        "typeName": "笔试",
        "category": "外语",
        "date": "2026-12-12",
        "endDate": "2026-12-12",
        "confirmed": true,
        "url": "https://cet.neea.edu.cn/html1/report/2609/1-1.htm",
        "publishedAt": "2026-09-02",
        "cycle": 2026,
        "startTime": "15:00",
        "endTime": "17:25"
      },
      {
        "examId": "ncre",
        "name": "全国计算机等级考试（NCRE）",
        "type": "written",
        "typeName": "笔试",
        "category": "计算机",
        "date": "2027-03-27",
        "endDate": "2027-03-29",
        "confirmed": false,
        "url": null,
        "publishedAt": null,
        "cycle": 2027,
        "rule": "规则推算：当月最后一个周六（历史命中率 2/3，窗口 2024–2026）"
      },
      {
        "examId": "cet4",
        "name": "全国大学英语四级考试（CET4）",
        "type": "written",
        "typeName": "笔试",
        "category": "外语",
        "date": "2027-06-12",
        "endDate": "2027-06-12",
        "confirmed": false,
        "url": null,
        "publishedAt": null,
        "cycle": 2027,
        "rule": "规则推算：当月第 2 个周六（历史命中率 5/8，窗口 2023H1–2026H2）"
      },
      {
        "examId": "cet6",
        "name": "全国大学英语六级考试（CET6）",
        "type": "written",
        "typeName": "笔试",
        "category": "外语",
        "date": "2027-06-12",
        "endDate": "2027-06-12",
        "confirmed": false,
        "url": null,
        "publishedAt": null,
        "cycle": 2027,
        "rule": "规则推算：当月第 2 个周六（历史命中率 5/8，窗口 2023H1–2026H2）"
      },
      {
        "examId": "ncre",
        "name": "全国计算机等级考试（NCRE）",
        "type": "written",
        "typeName": "笔试",
        "category": "计算机",
        "date": "2027-09-18",
        "endDate": "2027-09-20",
        "confirmed": false,
        "url": null,
        "publishedAt": null,
        "cycle": 2027,
        "rule": "规则推算：当月第 3 个周六（历史命中率 3/3，窗口 2024–2026）"
      },
      {
        "examId": "cet4",
        "name": "全国大学英语四级考试（CET4）",
        "type": "written",
        "typeName": "笔试",
        "category": "外语",
        "date": "2027-12-11",
        "endDate": "2027-12-11",
        "confirmed": false,
        "url": null,
        "publishedAt": null,
        "cycle": 2027,
        "rule": "规则推算：当月第 2 个周六（历史命中率 5/8，窗口 2023H1–2026H2）"
      },
      {
        "examId": "cet6",
        "name": "全国大学英语六级考试（CET6）",
        "type": "written",
        "typeName": "笔试",
        "category": "外语",
        "date": "2027-12-11",
        "endDate": "2027-12-11",
        "confirmed": false,
        "url": null,
        "publishedAt": null,
        "cycle": 2027,
        "rule": "规则推算：当月第 2 个周六（历史命中率 5/8，窗口 2023H1–2026H2）"
      },
      {
        "examId": "putonghua",
        "name": "普通话水平测试（PSC）· 下半年各省分批",
        "type": "registration",
        "typeName": "分批报名",
        "category": "语言",
        "date": "2026-09-01",
        "endDate": "2026-12-31",
        "confirmed": false,
        "url": "https://bm.cltt.org/",
        "publishedAt": null,
        "cycle": 2026,
        "rule": "普通话水平测试无全国统一考试日期：由各省（市）语委与测试站分批组织，频次从每年 1 次到每月开考不等，报名与测试时间各省不同。此处标注的是下半年报名与测试窗口，不是具体考试日；批次与日期以国家普通话水平测试在线报名系统 bm.cltt.org 各省测试站计划为准"
      },
      {
        "examId": "putonghua",
        "name": "普通话水平测试（PSC）· 上半年各省分批",
        "type": "registration",
        "typeName": "分批报名",
        "category": "语言",
        "date": "2027-03-01",
        "endDate": "2027-06-30",
        "confirmed": false,
        "url": "https://bm.cltt.org/",
        "publishedAt": null,
        "cycle": 2027,
        "rule": "按上下半年划分的报名与测试窗口推算，非具体考试日。普通话水平测试由各省（市）语委与测试站分批组织，实际批次以 bm.cltt.org 各省测试站计划为准"
      },
      {
        "examId": "putonghua",
        "name": "普通话水平测试（PSC）· 下半年各省分批",
        "type": "registration",
        "typeName": "分批报名",
        "category": "语言",
        "date": "2027-09-01",
        "endDate": "2027-12-31",
        "confirmed": false,
        "url": "https://bm.cltt.org/",
        "publishedAt": null,
        "cycle": 2027,
        "rule": "按上下半年划分的报名与测试窗口推算，非具体考试日。普通话水平测试由各省（市）语委与测试站分批组织，实际批次以 bm.cltt.org 各省测试站计划为准"
      }
    ]
  };

  /* ── 常量与全局句柄 ──
   * 关键：setInterval 的句柄必须挂到全局。宿主「重新扫描」时旧闭包不会被销毁，
   * 新闭包的局部变量是全新的 null，clearInterval 清不掉上一轮的定时器 → 两条轮询。
   * 手册里的「幂等启动模板」用的正是局部变量，跨重扫防不住，这里必须上全局。 */
  const G = typeof window !== "undefined" ? window : globalThis;
  const TIMER_KEY = "__tideExamCalendarTimer";
  const STYLE_ID = "exam-calendar-style";
  const TICK_MS = 10 * 60 * 1000; // 10 分钟一次，克制轮询
  const REMIND_DAYS = [7, 3, 1, 0]; // 考前 N 天提醒（0=当天）
  const DEFAULTS = { leadDays: 7, onlyConfirmed: false, examFilter: "all" };
  // label 用于全流程面板标题，short 用于工具条 chips（长标签会把工具条撑成两行）
  const EXAM_FILTERS = [
    { id: "all", label: "全部考试", short: "全部" },
    { id: "cet4", label: "大学英语四级（CET4）", short: "CET4" },
    { id: "cet6", label: "大学英语六级（CET6）", short: "CET6" },
    { id: "ncre", label: "全国计算机等级考试（NCRE）", short: "NCRE" },
    { id: "ntce", label: "中小学教师资格考试（NTCE）", short: "教资" },
    { id: "putonghua", label: "普通话水平测试（PSC）", short: "普通话" },
    { id: "kaoyan", label: "全国硕士研究生招生考试", short: "考研" },
    { id: "tem4", label: "英语专业四级（TEM4）", short: "专四" },
    { id: "tem8", label: "英语专业八级（TEM8）", short: "专八" },
  ];
  const CET_SIGNUP_URL = "https://cet-bm.neea.edu.cn/";
  const PTH_SIGNUP_URL = "https://bm.cltt.org/";
  // 全流程面板里的「报名特别提示 + 直达入口」。CET 与普通话共用一个结构，避免再写一遍分支。
  const CET_GUIDE = {
    url: CET_SIGNUP_URL,
    action: "打开 CET 报名系统",
    note: "CET 报名时间可能因省份、学校或考点不同而不同。请考生按所在学校规定时间登录 CET 全国网上报名系统（cet-bm.neea.edu.cn），完成资格审核、笔试报名缴费及口试报名缴费。",
  };
  const SIGNUP_GUIDES = {
    cet4: CET_GUIDE,
    cet6: CET_GUIDE,
    putonghua: {
      url: PTH_SIGNUP_URL,
      action: "打开普通话报名系统",
      note: "普通话水平测试（PSC）没有全国统一考试日期，由各省（市）语委与测试站分批组织，频次从每年 1 次到每月开考不等，报名与测试时间各省不同。请登录国家普通话水平测试在线报名系统（bm.cltt.org），选择所在省份查看测试站计划并报名。",
    },
  };

  const WEEKDAY = "日一二三四五六";

  /* ── 时间工具（不自己拼字符串，统一用 host 的 mmOf/hhmmOf）── */
  function toUTC(dateStr) {
    const [y, m, d] = String(dateStr).split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  }
  function dayDiff(fromStr, toStr) {
    return Math.round((toUTC(toStr) - toUTC(fromStr)) / 86400000);
  }
  function shiftDate(dateStr, n) {
    const d = new Date(toUTC(dateStr) + n * 86400000);
    const p = function (x) { return (x < 10 ? "0" : "") + x; };
    return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate());
  }
  function weekdayOf(dateStr) {
    const [y, m, d] = String(dateStr).split("-").map(Number);
    return WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  }
  function fmtDate(dateStr) {
    return dateStr + " 周" + weekdayOf(dateStr);
  }
  function mdOf(dateStr) { return String(dateStr).slice(5); }
  function wdOf(dateStr) { return "周" + weekdayOf(dateStr); }
  /* 列表里年份已由分组标题承担，行内只留 月-日 + 星期；跨日补上结束日期与结束星期，
   * 避免旧写法「2026-09-19 周六~09-21」被读成「周六 ~ 09-21」。 */
  function dateLines(ev) {
    const end = (ev.endDate && ev.endDate !== ev.date) ? ev.endDate : "";
    if (!end) return { top: mdOf(ev.date), bottom: wdOf(ev.date) };
    return { top: mdOf(ev.date) + " → " + mdOf(end), bottom: wdOf(ev.date) + " → " + wdOf(end) };
  }
  function spanDays(ev) {
    return (ev.endDate && ev.endDate !== ev.date) ? dayDiff(ev.date, ev.endDate) + 1 : 1;
  }
  /* 倒计时分档：进行中 / ≤3 天 / ≤14 天 / ≤60 天 / 更远（改显示绝对日期或月数）。
   * 关键：进行中必须用 endDate 判断 —— 多日考试从第 2 天起 date 已经过去，
   * 只按 date 算差值会显示成「N 天前」（旧版就是这个 bug）。 */
  function isWindow(ev) { return ev.type === "registration" || ev.type === "pre-registration"; }
  function countdownInfo(ev, today) {
    const start = ev.date;
    const end = ev.endDate || ev.date;
    // 报名窗口（普通话这类各省分批、无全国统一日期的考试）不编造「剩 N 天」的截止感
    if (today >= start && today <= end) {
      if (isWindow(ev)) return { text: "报名中 · 各省分批", tone: "live" };
      const total = dayDiff(start, end) + 1;
      return { text: total > 1 ? "进行中 · 第 " + (dayDiff(start, today) + 1) + " 天" : "今天", tone: "live" };
    }
    const d = dayDiff(today, start);
    if (d <= 0) return { text: isWindow(ev) ? "本批已结束" : "已结束", tone: "far" };
    if (d === 1) return { text: isWindow(ev) ? "明天开始报名" : "明天", tone: "urgent" };
    if (d <= 3) return { text: d + " 天后" + (isWindow(ev) ? "开始报名" : ""), tone: "urgent" };
    if (d <= 14) return { text: d + " 天后" + (isWindow(ev) ? "开始报名" : ""), tone: "soon" };
    if (d <= 60) return { text: d + " 天后" + (isWindow(ev) ? "开始报名" : ""), tone: "near" };
    if (d <= 180) return { text: "约 " + Math.round(d / 30) + " 个月后", tone: "far" };
    return { text: start, tone: "far" };
  }

  /* ── 数据访问 ── */
  function allEvents() {
    const list = (DATA && Array.isArray(DATA.events)) ? DATA.events : [];
    return list.slice().sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });
  }
  function examFamilyIds(id) {
    if (id === "cet4") return ["cet4", "cet-set4"];
    if (id === "cet6") return ["cet6", "cet-set6"];
    return [id];
  }
  function eventBelongsToExam(e, id) {
    if (!id || id === "all") return true;
    const ids = examFamilyIds(id);
    if (ids.indexOf(e.examId) >= 0) return true;
    const merged = Array.isArray(e.mergedFrom) ? e.mergedFrom : [];
    return merged.some(function (x) { return ids.indexOf(x) >= 0; });
  }
  function filterLabel(id) {
    const hit = EXAM_FILTERS.find(function (x) { return x.id === id; });
    return hit ? hit.label : id;
  }
  function upcoming(today, opts) {
    const list = allEvents().filter(function (e) {
      const last = e.endDate || e.date;
      if (last < today) return false;
      if (opts && opts.onlyConfirmed && !e.confirmed) return false;
      if (opts && opts.examFilter && !eventBelongsToExam(e, opts.examFilter)) return false;
      return true;
    });
    /* 分批报名窗口（普通话这类，跨好几个月）是背景信息，排在同年的具体考试之后 ——
     * 否则一个 4 个月长的窗口会把「5 天后」的考试挤到第二屏。
     * 先按年分桶保证年份连续（渲染端按年分组，年份一旦交错会出现两个同名分组）。 */
    return list.sort(function (a, b) {
      const ay = a.date.slice(0, 4), by = b.date.slice(0, 4);
      if (ay !== by) return ay < by ? -1 : 1;
      const aw = isWindow(a) ? 1 : 0, bw = isWindow(b) ? 1 : 0;
      if (aw !== bw) return aw - bw;
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });
  }
  /* 已结束的场次：默认不占版面，收进底部「历史场次」折叠区 */
  function pastEvents(today, opts) {
    return allEvents().filter(function (e) {
      if ((e.endDate || e.date) >= today) return false;
      if (opts && opts.onlyConfirmed && !e.confirmed) return false;
      if (opts && opts.examFilter && !eventBelongsToExam(e, opts.examFilter)) return false;
      return true;
    });
  }
  /* 排进日程后的按钮状态：重建视图时靠标题比对恢复，避免刷新后「已排」标记丢失 */
  function blockTitleOf(ev) { return ev.name + "（" + ev.typeName + "）"; }
  function isScheduled(ev) {
    try {
      const sameDay = tide.blocks.list(ev.date) || [];
      return sameDay.some(function (b) { return b && b.title === blockTitleOf(ev); });
    } catch (e) { return false; }
  }
  function registrationEvents(examId, today) {
    return allEvents().filter(function (e) {
      if (!eventBelongsToExam(e, examId)) return false;
      if (e.type !== "registration" && e.type !== "pre-registration") return false;
      return (e.endDate || e.date) >= today;
    });
  }
  function nextExam(today) {
    const list = upcoming(today, null);
    return list.length ? list[0] : null;
  }

  /* ── 存储（每个插件存储完全隔离；损坏数据要能兜住）── */
  async function loadSettings() {
    const raw = await tide.storage.get("settings", null);
    const s = (raw && typeof raw === "object") ? raw : {};
    return {
      leadDays: typeof s.leadDays === "number" ? s.leadDays : DEFAULTS.leadDays,
      onlyConfirmed: !!s.onlyConfirmed,
      examFilter: typeof s.examFilter === "string" && EXAM_FILTERS.some(function (x) { return x.id === s.examFilter; }) ? s.examFilter : DEFAULTS.examFilter,
    };
  }
  async function saveSettings(s) {
    await tide.storage.set("settings", s);
  }
  async function loadReminded() {
    const raw = await tide.storage.get("reminded", []);
    return Array.isArray(raw) ? raw.filter(function (k) { return typeof k === "string"; }) : [];
  }

  /* ── 样式：注入前查重，重扫不会堆 <style> ── */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent =
      // 工具条：今天 + 筛选 chips + 搜索 + 最近一场 + 计数
      ".ecal-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px;font-size:calc(12px * var(--ui-text-scale))}" +
      ".ecal-today{color:var(--muted,#7E8B94);font-variant-numeric:tabular-nums}" +
      ".ecal-chips{display:flex;flex-wrap:wrap;gap:6px}" +
      ".ecal-chip{font:inherit;font-size:calc(12px * var(--ui-text-scale));padding:3px 10px;border-radius:999px;border:1px solid var(--border,#E4DFD6);background:transparent;color:var(--muted,#7E8B94);cursor:pointer}" +
      ".ecal-chip:hover{border-color:var(--ink-3,#A9B2BA);color:var(--ink,#22303A)}" +
      ".ecal-chip[aria-pressed=true]{background:var(--accent,#0F4C5C);border-color:var(--accent,#0F4C5C);color:#fff}" +
      /* 搜索框只留一颗放大镜（用户要求「删除所有搜索框内的中文，仅保留搜索图标」） */
      ".ecal-searchbox{position:relative;display:inline-flex;align-items:center}" +
      ".ecal-searchbox>.ecal-search{padding-left:28px}" +
      ".ecal-search-ico{position:absolute;left:9px;width:14px;height:14px;display:inline-flex;color:inherit;opacity:.55;pointer-events:none}" +
      ".ecal-search-ico svg{width:100%;height:100%;display:block}" +
      ".ecal-search{font:inherit;font-size:calc(12px * var(--ui-text-scale));padding:4px 10px;border-radius:8px;border:1px solid var(--border,#E4DFD6);background:transparent;color:inherit;min-width:150px;max-width:220px}" +
      ".ecal-count{margin-left:auto;color:var(--muted,#7E8B94);font-variant-numeric:tabular-nums}" +
      ".ecal-btn{font:inherit;font-size:calc(12px * var(--ui-text-scale));padding:3px 10px;border-radius:8px;border:1px solid var(--border,#E4DFD6);background:transparent;color:inherit;cursor:pointer;white-space:nowrap}" +
      ".ecal-btn:hover:not([disabled]){border-color:var(--ink-3,#A9B2BA)}" +
      ".ecal-btn[disabled]{opacity:.45;cursor:default}" +
      ".ecal-btn.done{border-color:var(--mint,#2EC4B6);color:var(--mint,#2EC4B6)}" +
      // 年份分组
      ".ecal-year{display:flex;align-items:baseline;gap:8px;margin:14px 2px 8px;padding-bottom:4px;border-bottom:1px dashed var(--border,#E4DFD6);font-size:calc(12px * var(--ui-text-scale));font-weight:700;letter-spacing:.14em;color:var(--muted,#7E8B94)}" +
      ".ecal-year small{font-weight:400;letter-spacing:0;opacity:.85}" +
      // 行：日期列（定宽，考试名才不会参差）+ 主体 + 操作。
      // 用 flex-wrap 而不是三列 grid：日期 87px + 间隔 24px + 操作 226px 已经 337px，
      // 而手机上面板内容盒只有 328px —— 一行物理上装不下。旧版三列 grid 里
      // 「主体列 minmax(0,1fr)」会被压到 0 宽，主体里的 nowrap 文字直接画到操作列上，
      // 看起来就是文字互相压住。现在容器不够宽时操作整块换到第二行。
      ".ecal-row{--ecal-date-w:92px;display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px 12px;padding:12px;border:1px solid var(--border,#E4DFD6);border-radius:10px;margin-bottom:6px}" +
      ".ecal-row:hover{border-color:var(--ink-3,#A9B2BA)}" +
      ".ecal-row.est{border-style:dashed;opacity:.72}" +
      ".ecal-row.hot{border-left:3px solid var(--coral,#FF6B6B)}" +
      ".ecal-row.join-next{margin-bottom:0;border-bottom-left-radius:0;border-bottom-right-radius:0}" +
      ".ecal-row.same-day{border-top:none;border-top-left-radius:0;border-top-right-radius:0}" +
      // 「日期 + 主体」绑成一个整体再跟操作块一起换行。
      // 否则 360px 宽时 dcol(92)+bcol(200)+间隙(12)=304 已经超过可用的 298，
      // flex 会把主体整列挤到第 2 行、日期孤零零占一行，行高从 96 涨到 143。
      ".ecal-main{flex:1 1 404px;min-width:0;display:flex;align-items:flex-start;gap:12px}" +
      ".ecal-dcol{flex:0 0 var(--ecal-date-w,92px);min-width:0}" +
      ".ecal-d1{font-size:calc(13px * var(--ui-text-scale));line-height:1.5;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".ecal-d2{font-size:calc(12px * var(--ui-text-scale));line-height:1.5;color:var(--muted,#7E8B94);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".ecal-d2.same{opacity:.55}" +
      ".ecal-bcol{flex:1 1 0;min-width:0;overflow:hidden}" +
      ".ecal-l1{display:flex;align-items:center;gap:6px;min-width:0;font-size:calc(13px * var(--ui-text-scale));line-height:1.5}" +
      ".ecal-name{font:inherit;font-size:calc(13px * var(--ui-text-scale));font-weight:600;background:none;border:none;color:inherit;padding:0;margin:0;cursor:pointer;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0}" +
      ".ecal-name:hover{text-decoration:underline;text-underline-offset:3px}" +
      ".ecal-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--mint,#2EC4B6)}" +
      ".ecal-dot.est{background:transparent;box-shadow:inset 0 0 0 1px var(--ink-3,#A9B2BA)}" +
      ".ecal-tag{display:inline-block;vertical-align:1px;margin-right:6px;font-size:calc(12px * var(--ui-text-scale));font-weight:400;padding:1px 6px;border-radius:4px;background:var(--soft,#F7F6F2);color:var(--muted,#7E8B94)}" +
      ".ecal-l2{font-size:calc(12px * var(--ui-text-scale));line-height:1.5;color:var(--muted,#7E8B94);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".ecal-acts{flex:0 0 auto;margin-left:auto;display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:8px}" +
      ".ecal-cd{font-size:calc(12px * var(--ui-text-scale));font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--muted,#7E8B94)}" +
      ".ecal-cd.urgent{color:var(--coral,#FF6B6B);font-weight:600}" +
      ".ecal-cd.soon{color:var(--sun,#E3A008);font-weight:600}" +
      ".ecal-cd.near{color:var(--ink,#22303A)}" +
      ".ecal-cd.live{color:var(--sea,#118AB2);font-weight:600}" +
      ".ecal-empty{opacity:.7;padding:12px 0}" +
      ".ecal-foot{margin-top:12px;font-size:calc(12px * var(--ui-text-scale));opacity:.6;line-height:1.7}" +
      ".ecal-stale{margin:10px 0;padding:9px 12px;border:1px solid var(--border,#E4DFD6);border-left:3px solid var(--sun,#E3A008);border-radius:10px;font-size:calc(12px * var(--ui-text-scale));color:var(--muted,#7E8B94);line-height:1.7}" +
      ".ecal-flow{margin:10px 0 12px;padding:12px;border:1px solid var(--border,#E4DFD6);border-radius:12px;background:var(--soft,#F7F6F2)}" +
      ".ecal-flow-title{font-weight:700;margin-bottom:7px}" +
      ".ecal-flow-line{font-size:calc(12px * var(--ui-text-scale));line-height:1.75;opacity:.85}" +
      ".ecal-flow>.ecal-btn{margin-top:8px;margin-right:6px}" +
      ".ecal-warn{margin-top:8px;padding:8px 10px;border-left:3px solid var(--sun,#E3A008);font-size:calc(12px * var(--ui-text-scale));line-height:1.75;opacity:.85}" +
      ".ecal-hist{margin-top:16px;padding-top:12px;border-top:1px solid var(--border,#E4DFD6)}" +
      ".ecal-hist-box{margin-top:10px}" +
      ".ecal-hist-year{margin:10px 2px 4px;font-size:calc(12px * var(--ui-text-scale));color:var(--muted,#7E8B94);letter-spacing:.14em}" +
      ".ecal-hist-line{display:flex;gap:10px;padding:4px 2px;font-size:calc(12px * var(--ui-text-scale));color:var(--muted,#7E8B94);border-bottom:1px solid var(--line-soft,#EFEAE1)}" +
      ".ecal-hist-line b{font-weight:600;color:var(--ink,#22303A);min-width:112px;font-variant-numeric:tabular-nums}" +
      ".ecal-hist-line span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}";
    document.head.append(st);
  }

  /* ── 排进日程：任务 + 时间块（宿主推荐的两步写法）──
   * 跨日考试（NCRE 连考 3 天、教资 2 天）必须把整个区间都排上，
   * 只排 date 第一天会让第 2、3 天在日程里凭空消失。 */
  function blockMinutes(ev) {
    if (ev.startTime && ev.endTime) {
      const d = tide.util.mmOf(ev.endTime) - tide.util.mmOf(ev.startTime);
      if (d > 0) return d;
    }
    return ev.type === "written" ? 150 : 60;
  }
  function examDays(ev) {
    const last = ev.endDate || ev.date;
    const n = dayDiff(ev.date, last);
    const days = [];
    for (let i = 0; i <= n; i++) days.push(shiftDate(ev.date, i));
    return days;
  }
  async function addToSchedule(ev) {
    const title = blockTitleOf(ev);
    const days = examDays(ev);
    const hit = days.filter(function (d) {
      const sameDay = tide.blocks.list(d) || [];
      return sameDay.some(function (b) { return b && b.title === title; });
    });
    if (hit.length) {
      tide.notify("已排进 " + fmtDate(ev.date) + " 的日程");
      return false;
    }
    const dur = blockMinutes(ev);
    const task = tide.tasks.create({
      title: title,
      note: noteOf(ev),
      quad: tide.util.guessQuad(ev.date),
      estMin: dur,
      tags: ["考试"],
      project: "考试日历",
      due: ev.endDate || ev.date, // 跨日考试的截止日是最后一天
    });
    days.forEach(function (d) {
      tide.blocks.create({
        date: d,
        start: ev.startTime || "09:00",
        durMin: dur,
        title: title,
        taskId: task.id,
        cat: "study",
      });
    });
    tide.notify(days.length > 1
      ? "已排进日程：" + fmtDate(ev.date) + " 起连续 " + days.length + " 天"
      : "已排进日程：" + fmtDate(ev.date));
    return true;
  }

  function noteOf(ev) {
    const parts = [];
    const span = spanDays(ev);
    if (span > 1) parts.push("考试时间：" + ev.date + " ~ " + ev.endDate + "（共 " + span + " 天）");
    parts.push(ev.confirmed ? "官方公告已确认" : "规则推算，待官方公告确认");
    if (ev.url) parts.push(ev.url);
    return parts.join("\n");
  }

  /* ── 视图 ── */
  let query = "";       // 搜索词：会话内有效，不落盘
  let histOpen = false; // 历史场次折叠状态

  function setChip(btn, on) { btn.setAttribute("aria-pressed", on ? "true" : "false"); }

  /* 点击考试名进入该项全流程，再点一次回到全部。
   * 旧版是每行一个「看全流程」按钮（14 行 = 14 个按钮），切全局筛选却没有明显出口。 */
  async function openFlow(ev, el) {
    let target = ev.examId;
    if (target === "cet-set4") target = "cet4";
    if (target === "cet-set6") target = "cet6";
    if (!EXAM_FILTERS.some(function (x) { return x.id === target; })) {
      tide.notify("该项目暂不支持独立全流程筛选");
      return;
    }
    const st = await loadSettings();
    st.examFilter = (st.examFilter === target) ? "all" : target;
    await saveSettings(st);
    await render(el);
  }

  /* 已结束的场次：默认折叠，避免 60 多场历史把列表撑爆 */
  function historySection(past, el) {
    const wrap = document.createElement("div");
    wrap.className = "ecal-hist";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "ecal-btn";
    toggle.textContent = (histOpen ? "收起" : "展开") + "历史场次（" + past.length + " 场）";
    toggle.addEventListener("click", function () { histOpen = !histOpen; void render(el); });
    wrap.append(toggle);
    if (!histOpen) return wrap;

    const box = document.createElement("div");
    box.className = "ecal-hist-box";
    const byYear = [];
    past.slice().reverse().forEach(function (ev) { // allEvents 升序，倒过来让最近的排前面
      const y = ev.date.slice(0, 4);
      let g = byYear[byYear.length - 1];
      if (!g || g.year !== y) { g = { year: y, items: [] }; byYear.push(g); }
      g.items.push(ev);
    });

    byYear.forEach(function (g) {
      const h = document.createElement("div");
      h.className = "ecal-hist-year";
      h.textContent = g.year + " 年 · " + g.items.length + " 场";
      box.append(h);
      g.items.forEach(function (ev) {
        const line = document.createElement("div");
        line.className = "ecal-hist-line";
        const b = document.createElement("b");
        b.textContent = ev.date + ((ev.endDate && ev.endDate !== ev.date) ? " ~ " + mdOf(ev.endDate) : "");
        const s = document.createElement("span");
        s.textContent = ev.name + ((ev.type !== "written" && ev.typeName) ? " · " + ev.typeName : "");
        line.append(b, s);
        if (ev.url) {
          const a = document.createElement("button");
          a.type = "button";
          a.className = "ecal-btn";
          a.textContent = "公告";
          a.addEventListener("click", function () { tide.util.openUrl(ev.url); });
          line.append(a);
        }
        box.append(line);
      });
    });
    wrap.append(box);
    return wrap;
  }

  async function render(el) {
    el.replaceChildren(); // 幂等：每次进入视图都重建
    ensureStyle();

    const today = tide.util.today();
    const settings = await loadSettings();
    const all = upcoming(today, settings);
    const past = pastEvents(today, settings);
    const official = all.filter(function (e) { return e.confirmed; }).length;

    /* ── 工具条：今天 + 筛选 chips + 搜索 + 最近一场 + 计数 ── */
    const tools = document.createElement("div");
    tools.className = "ecal-tools";

    const todayEl = document.createElement("span");
    todayEl.className = "ecal-today";
    todayEl.textContent = "今天 " + fmtDate(today);
    tools.append(todayEl);

    const chips = document.createElement("div");
    chips.className = "ecal-chips";
    EXAM_FILTERS.forEach(function (x) {
      const c = document.createElement("button");
      c.type = "button";
      c.className = "ecal-chip";
      c.textContent = x.short || x.label;
      c.title = x.label;
      setChip(c, settings.examFilter === x.id);
      c.addEventListener("click", async function () {
        const st = await loadSettings();
        st.examFilter = x.id;
        await saveSettings(st);
        await render(el);
      });
      chips.append(c);
    });
    const onlyBtn = document.createElement("button");
    onlyBtn.type = "button";
    onlyBtn.className = "ecal-chip";
    onlyBtn.textContent = "只看官方";
    onlyBtn.title = "隐藏规则推算的场次";
    setChip(onlyBtn, settings.onlyConfirmed);
    onlyBtn.addEventListener("click", async function () {
      const st = await loadSettings();
      st.onlyConfirmed = !st.onlyConfirmed;
      await saveSettings(st);
      await render(el);
    });
    chips.append(onlyBtn);
    const filterMenu = document.createElement("details");
    filterMenu.className = "plugin-filter-menu";
    const filterLabel = document.createElement("summary");
    filterLabel.textContent = settings.examFilter === "all" && !settings.onlyConfirmed
      ? "筛选考试"
      : `筛选考试 · ${EXAM_FILTERS.find((x) => x.id === settings.examFilter)?.short || "全部"}${settings.onlyConfirmed ? " · 官方" : ""}`;
    const filterPanel = document.createElement("div");
    filterPanel.className = "plugin-filter-menu-panel";
    filterPanel.append(chips);
    filterMenu.append(filterLabel, filterPanel);
    tools.append(filterMenu);

    const search = document.createElement("input");
    search.className = "ecal-search";
    search.type = "search";
    // 搜索框里不再写中文提示，只留一颗前置放大镜（提示改挂 title）
    search.title = "搜索考试名称";
    search.setAttribute("aria-label", "搜索考试名称");
    search.value = query;
    const searchBox = document.createElement("span");
    searchBox.className = "ecal-searchbox";
    searchBox.innerHTML = '<span class="ecal-search-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/></svg></span>';
    searchBox.append(search);
    tools.append(searchBox);

    if (all.length) {
      const jump = document.createElement("button");
      jump.type = "button";
      jump.className = "ecal-btn";
      jump.textContent = "最近一场排进日程";
      jump.addEventListener("click", function () { void addToSchedule(all[0]); });
      tools.append(jump);
    }

    const countEl = document.createElement("span");
    countEl.className = "ecal-count";
    tools.append(countEl);
    el.append(tools);

    // 数据陈旧提示：离线采集数据超过 30 天即明确告知（原阈值 90 天，等到提示时最近一场考试往往已经考完）
    const staleDays = DATA.collectedForDate ? dayDiff(DATA.collectedForDate, today) : 0;
    if (staleDays >= 30) {
      const stale = document.createElement("div");
      stale.className = "ecal-stale";
      stale.textContent = "离线数据采集于 " + DATA.collectedForDate + "（" + staleDays + " 天前）。考试日期可能已有调整，报名与准考证信息请以官方公告和考点通知为准。";
      el.append(stale);
    }

    if (settings.examFilter !== "all") {
      const flow = document.createElement("div");
      flow.className = "ecal-flow";
      const ft = document.createElement("div");
      ft.className = "ecal-flow-title";
      ft.textContent = filterLabel(settings.examFilter) + " · 全流程";
      flow.append(ft);

      const regs = registrationEvents(settings.examFilter, today);
      const regLine = document.createElement("div");
      regLine.className = "ecal-flow-line";
      if (regs.length) {
        regLine.textContent = "已收录报名时间：" + regs.map(function (r) {
          return (r.type === "pre-registration" ? "预报名 " : "报名 ") + r.date + ((r.endDate && r.endDate !== r.date) ? " ～ " + r.endDate : "") + (r.confirmed ? "（官方）" : "（预计）");
        }).join("；");
      } else {
        regLine.textContent = "报名时间：当前离线数据尚未收录可用的全国统一报名起止时间，请以考试官网及所在学校/考点通知为准。";
      }
      flow.append(regLine);

      const guide = SIGNUP_GUIDES[settings.examFilter];
      if (guide) {
        const warn = document.createElement("div");
        warn.className = "ecal-warn";
        warn.textContent = guide.note;
        flow.append(warn);
        const signup = document.createElement("button");
        signup.type = "button";
        signup.className = "ecal-btn";
        signup.textContent = guide.action;
        signup.addEventListener("click", function () { tide.util.openUrl(guide.url); });
        flow.append(signup);
      }

      const back = document.createElement("button");
      back.type = "button";
      back.className = "ecal-btn";
      back.textContent = "回到全部考试";
      back.addEventListener("click", async function () {
        const st = await loadSettings();
        st.examFilter = "all";
        await saveSettings(st);
        await render(el);
      });
      flow.append(back);
      el.append(flow);
    }

    if (!all.length) {
      const empty = document.createElement("div");
      empty.className = "ecal-empty";
      empty.textContent = settings.onlyConfirmed
        ? "没有「官方已确认」的未来考次——关掉「只看官方」可以看到规则推算的场次。"
        : "没有收录到未来的考次。";
      el.append(empty);
    }

    /* ── 列表：按年分组，行内三列 grid ── */
    const groups = [];
    all.forEach(function (ev) {
      const y = ev.date.slice(0, 4);
      let g = groups[groups.length - 1];
      if (!g || g.year !== y) { g = { year: y, items: [] }; groups.push(g); }
      g.items.push(ev);
    });

    const rows = [];
    groups.forEach(function (g) {
      const wrap = document.createElement("div");
      wrap.className = "ecal-group";

      const estAll = g.items.every(function (e) { return !e.confirmed; });
      const head = document.createElement("div");
      head.className = "ecal-year";
      head.append(document.createTextNode(g.year + " 年"));
      const sub = document.createElement("small");
      sub.textContent = g.items.length + " 场" + (estAll ? " · 规则推算，仅供参考" : "");
      head.append(sub);
      wrap.append(head);

      g.items.forEach(function (ev, i) {
        const sameDay = i > 0 && g.items[i - 1].date === ev.date;
        const nextEv = g.items[i + 1];
        const joinNext = !!(nextEv && nextEv.date === ev.date);
        const cd = countdownInfo(ev, today);
        const dl = dateLines(ev);
        const span = spanDays(ev);

        const row = document.createElement("div");
        const hot = cd.tone === "urgent" || cd.tone === "live";
        row.className = "ecal-row" + (ev.confirmed ? "" : " est") + (hot ? " hot" : "") + (joinNext ? " join-next" : "") + (sameDay ? " same-day" : "");
        row.dataset.search = (ev.name + " " + (ev.category || "") + " " + (ev.typeName || "")).toLowerCase();

        const dcol = document.createElement("div");
        dcol.className = "ecal-dcol";
        const d1 = document.createElement("div");
        d1.className = "ecal-d1";
        const d2 = document.createElement("div");
        d2.className = "ecal-d2";
        if (sameDay) {
          d2.textContent = "同日";
          d2.classList.add("same");
        } else {
          d1.textContent = dl.top;
          d2.textContent = dl.bottom;
        }
        dcol.append(d1, d2);

        const bcol = document.createElement("div");
        bcol.className = "ecal-bcol";
        const l1 = document.createElement("div");
        l1.className = "ecal-l1";
        const dot = document.createElement("span");
        dot.className = "ecal-dot" + (ev.confirmed ? "" : " est");
        dot.title = ev.confirmed ? "官方公告已确认" : "规则推算，待官方公告确认";
        l1.append(dot);

        const nm = document.createElement("button");
        nm.type = "button";
        nm.className = "ecal-name";
        nm.textContent = ev.name;
        nm.title = eventBelongsToExam(ev, settings.examFilter)
          ? "再点一次回到全部考试"
          : "查看 " + ev.name + " 的全流程";
        nm.addEventListener("click", function () { void openFlow(ev, el); });
        l1.append(nm);

        const l2 = document.createElement("div");
        l2.className = "ecal-l2";
        // 类型标签（口试 / 准考证打印 / 分批报名…）挂在 meta 行首，不跟考试名抢同一行：
        // 标签最宽 72px，和最长 239px 的考试名同处 224px 时，名字会被挤到 134px 只显示 9 个字。
        if (ev.type !== "written") {
          const tag = document.createElement("span");
          tag.className = "ecal-tag";
          tag.textContent = ev.typeName;
          l2.append(tag);
        }
        const meta = [];
        if (ev.category) meta.push(ev.category);
        if (span > 1 && !isWindow(ev)) meta.push("连续 " + span + " 天");
        if (ev.startTime) meta.push(ev.startTime + "–" + (ev.endTime || ""));
        meta.push(ev.confirmed ? "官方已确认" : "规则推算");
        l2.append(document.createTextNode(meta.join(" · ")));
        bcol.append(l1, l2);

        const acts = document.createElement("div");
        acts.className = "ecal-acts";
        const cds = document.createElement("span");
        cds.className = "ecal-cd " + cd.tone;
        cds.textContent = cd.text;
        acts.append(cds);

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ecal-btn";
        if (isScheduled(ev)) {
          btn.textContent = "已在日程";
          btn.classList.add("done");
          btn.disabled = true;
        } else {
          btn.textContent = "排进日程";
          btn.addEventListener("click", async function () {
            btn.disabled = true;
            const ok = await addToSchedule(ev);
            btn.textContent = ok ? "已排 ✓" : "已在日程";
            btn.classList.add("done");
          });
        }
        acts.append(btn);

        if (ev.url) {
          const link = document.createElement("button");
          link.type = "button";
          link.className = "ecal-btn";
          link.textContent = isWindow(ev) ? "报名" : "公告";
          link.title = (isWindow(ev) ? "打开官方报名入口：" : "打开官方公告：") + ev.url;
          link.addEventListener("click", function () { tide.util.openUrl(ev.url); });
          acts.append(link);
        }

        const main = document.createElement("div");
        main.className = "ecal-main";
        main.append(dcol, bcol);
        row.append(main, acts);
        wrap.append(row);
        rows.push(row);
      });

      el.append(wrap);
    });

    if (past.length) el.append(historySection(past, el));

    const foot = document.createElement("div");
    foot.className = "ecal-foot";
    foot.textContent =
      "数据来自官方公告采集，生成于 " + (DATA.generatedAt || "未知") + "；" +
      "标注「预计」的日期由历史规律推算，可能整周偏差，仅用于倒计时。" +
      "报名、缴费、准考证一律以官方公告与考点通知为准。CET 各考点报名时间可能不同，请按所在学校通知登录 cet-bm.neea.edu.cn 完成报名缴费。";
    el.append(foot);

    /* 搜索只切显隐、不重建 DOM —— 重建会丢输入框焦点 */
    function applySearch() {
      const q = query.trim().toLowerCase();
      let shown = 0;
      rows.forEach(function (r) {
        const hit = !q || r.dataset.search.indexOf(q) >= 0;
        r.hidden = !hit;
        if (hit) shown++;
      });
      el.querySelectorAll(".ecal-group").forEach(function (g) {
        const any = Array.prototype.some.call(g.querySelectorAll(".ecal-row"), function (r) { return !r.hidden; });
        g.hidden = !any;
      });
      countEl.textContent = "未来 " + all.length + " 场 · 官方 " + official + " / 预计 " + (all.length - official) +
        (q ? " · 匹配 " + shown : "");
    }
    search.addEventListener("input", function () { query = search.value; applySearch(); });
    applySearch();
  }

  /* ── 任务动作：把任务的截止日设为最近一场相关考试 ── */
  const KEYWORDS = [
    { re: /六级|6级|CET6/i, ids: ["cet6"] },
    { re: /四级|4级|CET4/i, ids: ["cet4"] },
    { re: /四六级|CET/i, ids: ["cet4", "cet6"] },
    { re: /考研|研究生初试|硕士/, ids: ["kaoyan"] },
    { re: /教资|教师资格/, ids: ["ntce"] },
    { re: /计算机等级|NCRE|计算机二级/i, ids: ["ncre"] },
    { re: /专八|TEM8/i, ids: ["tem8"] },
    { re: /专四|TEM4/i, ids: ["tem4"] },
    { re: /普通话|PSC|二甲|二乙|一甲|一乙/, ids: ["putonghua"] },
  ];

  function matchExam(title, today) {
    if (!title) return null;
    for (let i = 0; i < KEYWORDS.length; i++) {
      if (!KEYWORDS[i].re.test(title)) continue;
      const ids = KEYWORDS[i].ids;
      const hit = upcoming(today, null).filter(function (e) { return ids.indexOf(e.examId) >= 0; });
      if (hit.length) return hit[0];
    }
    return null;
  }

  /* ── 后台提醒：加载即启动；用带日期的去重键防重复推送 ── */
  async function tick() {
    const today = tide.util.today();
    const settings = await loadSettings();
    const list = upcoming(today, settings);
    const reminded = await loadReminded();
    const keep = reminded.filter(function (k) { return k.indexOf(today) >= 0; });

    // 把未来场次快照落盘：主程序的自动化（automation.js 的 examReminderFromStorage）
    // 与其它视图都从 plugins["exam-calendar"].storage.events 读，此前插件从不写这个键。
    try {
      await tide.storage.set("events", upcoming(today, null).map(function (e) {
        return {
          id: e.examId + "|" + e.type + "|" + e.date,
          examId: e.examId,
          title: e.name,
          name: e.name,
          type: e.type,
          typeName: e.typeName,
          date: e.date,
          endDate: e.endDate || e.date,
          confirmed: !!e.confirmed,
        };
      }));
    } catch (e) { console.error("[exam-calendar] 写入 events 快照失败", e); }

    for (let i = 0; i < list.length; i++) {
      const ev = list[i];
      const d = dayDiff(today, ev.date);
      // 跨日考试的第二天起 date 已经过去，只在 REMIND_DAYS 命中会整段静默 —— 补一次「最后一天」提醒
      const lastDay = !!(ev.endDate && ev.endDate !== ev.date && ev.endDate === today);
      if (REMIND_DAYS.indexOf(d) < 0 && !lastDay) continue;
      const key = today + "|" + ev.examId + "|" + ev.type + "|" + d;
      if (keep.indexOf(key) >= 0) continue;
      keep.push(key);
      const when = lastDay ? "今天是最后一天" : (d === 0 ? "就是今天" : "还有 " + d + " 天");
      tide.notify(ev.name + "（" + ev.typeName + "）" + when + "：" + fmtDate(ev.date) + (ev.confirmed ? "" : " · 预计"), { ms: 6000 });
      if (tide.inbox && typeof tide.inbox.create === "function") tide.inbox.create({ sourceKey: `exam:${ev.examId}:${ev.type}:${ev.date}`, title: ev.name + " · " + ev.typeName, when: ev.date, note: when + (ev.confirmed ? " · 官方已确认" : " · 预计日期，请以官方公告为准"), suggestion: "create-task" });
      tide.events.emit("exam-calendar:reminder", { examId: ev.examId, date: ev.date, days: d, confirmed: ev.confirmed });
    }
    // 只保留今天的键 + 未过期的"提前提醒"键，避免存储无限增长
    await tide.storage.set("reminded", keep.slice(-200));
  }

  function startTimer() {
    if (G[TIMER_KEY]) clearInterval(G[TIMER_KEY]); // 关键：清上一轮（可能是旧闭包的）定时器
    G[TIMER_KEY] = setInterval(function () {
      tick().catch(function (e) { console.error("[exam-calendar] tick 失败", e); });
    }, TICK_MS);
  }

  /* ── 注册 ── */
  tide.ui.registerView({
    id: "exam-calendar",
    title: "考试日历",
    icon: 'calendar-check',
    render: render,
  });

  tide.ui.registerTaskAction({
    id: "exam-calendar-set-due",
    label: "设为最近考试截止日",
    icon: "考",
    run: function (task) {
      const today = tide.util.today();
      const ev = matchExam(task && task.title, today);
      if (!ev) {
        tide.notify("标题里没匹配到已收录的考试（四六级/考研/教资/计算机等级/专四专八/普通话）");
        return;
      }
      tide.tasks.update(task.id, { due: ev.date, quad: tide.util.guessQuad(ev.date) });
      tide.notify("截止日已设为 " + ev.date + "（" + ev.name + "）");
    },
  });

  startTimer();
  tick().catch(function (e) { console.error("[exam-calendar] 首次检查失败", e); });
  tide.events.emit("exam-calendar:loaded", { events: allEvents().length, generatedAt: DATA.generatedAt || null });
})();
