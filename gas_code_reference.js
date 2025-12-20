function doPost(e) {
    // CORS対応 (OPTIONSリクエストへの対応が必要な場合があるが、Next.js Proxy経由なら基本不要)
    // ただし、もし直接叩く場合のためにヘッダーをつけておくのは親切

    try {
        var data = JSON.parse(e.postData.contents);
        var base64 = data.fileData;
        var mimeType = data.mimeType || "audio/wav";
        var userName = data.userName || "unknown";

        // ユーザー名と日時をファイル名にする
        var sanitizedName = userName.replace(/[\\/:*?"<>|]/g, "_"); // ファイル名に使えない文字を置換
        var fileName = sanitizedName + "_" + Utilities.formatDate(new Date(), "JST", "yyyyMMdd_HHmmss") + ".wav";

        // Base64デコード
        var decoded = Utilities.base64Decode(base64);
        var blob = Utilities.newBlob(decoded, mimeType, fileName);

        // Google Driveのルートフォルダに保存（必要に応じてフォルダIDを指定してください）
        // var folder = DriveApp.getFolderById("YOUR_FOLDER_ID");
        // var file = folder.createFile(blob);
        var file = DriveApp.createFile(blob);

        var response = {
            result: "success",
            fileId: file.getId(),
            fileName: file.getName()
        };

        return ContentService.createTextOutput(JSON.stringify(response))
            .setMimeType(ContentService.MimeType.JSON);

    } catch (error) {
        var errorResponse = {
            result: "error",
            message: error.toString()
        };

        return ContentService.createTextOutput(JSON.stringify(errorResponse))
            .setMimeType(ContentService.MimeType.JSON);
    }
}
