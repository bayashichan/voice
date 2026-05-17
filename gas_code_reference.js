// Google Apps Script - 声紋録音データ保存・管理用
// このコードをGASエディタに貼り付けてデプロイしてください
//
// デプロイ設定:
//   - 種類: ウェブアプリ
//   - 次のユーザーとして実行: 自分
//   - アクセスできるユーザー: 全員

// 録音ファイルを保存するフォルダ名（Googleドライブに自動作成されます）
var FOLDER_NAME = "声紋録音データ";

// 通知メールの送信先（録音が届いたときにここに通知が来ます）
// ← ご自身のGmailアドレスに変更してください
var NOTIFY_EMAIL = "wakaossan2001@gmail.com";

// フォルダを取得（なければ作成）
function getOrCreateFolder() {
  var folders = DriveApp.getFoldersByName(FOLDER_NAME);
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder(FOLDER_NAME);
}

// GETリクエスト: ファイル一覧・削除・音声取得を行う（管理画面用）
function doGet(e) {
  var action = e && e.parameter && e.parameter.action;

  // ファイル一覧取得
  if (action === "list") {
    try {
      var folder = getOrCreateFolder();
      var files = folder.getFiles();
      var list = [];

      while (files.hasNext()) {
        var file = files.next();
        // 音声ファイルのみ返す
        if (file.getMimeType().indexOf("audio") !== -1 || file.getName().endsWith(".wav")) {
          list.push({
            id: file.getId(),
            name: file.getName(),
            size: file.getSize(),
            createdAt: file.getDateCreated().toISOString(),
            url: "https://drive.google.com/file/d/" + file.getId() + "/view"
          });
        }
      }

      // 新しい順にソート
      list.sort(function(a, b) {
        return new Date(b.createdAt) - new Date(a.createdAt);
      });

      return ContentService
        .createTextOutput(JSON.stringify({ result: "success", files: list }))
        .setMimeType(ContentService.MimeType.JSON);

    } catch (error) {
      return ContentService
        .createTextOutput(JSON.stringify({ result: "error", message: error.toString() }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // 音声ファイルをBase64で返す（管理画面の再生プロキシ）
  // Googleドライブの共有設定に依存せず、GASが直接取得して返す
  if (action === "audio") {
    try {
      var fileId = e.parameter.id;
      if (!fileId) throw new Error("ファイルIDが未指定です");
      var audioFile = DriveApp.getFileById(fileId);
      var blob = audioFile.getBlob();
      var base64 = Utilities.base64Encode(blob.getBytes());
      return ContentService
        .createTextOutput(JSON.stringify({
          result: "success",
          base64: base64,
          mimeType: blob.getContentType() || "audio/wav",
          name: audioFile.getName()
        }))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (error) {
      return ContentService
        .createTextOutput(JSON.stringify({ result: "error", message: error.toString() }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // ファイル削除
  if (action === "delete") {
    try {
      var fileId = e.parameter.id;
      if (!fileId) throw new Error("ファイルIDが未指定です");
      var targetFile = DriveApp.getFileById(fileId);
      targetFile.setTrashed(true); // ゴミ箱に移動（完全削除でなく復元可能）
      return ContentService
        .createTextOutput(JSON.stringify({ result: "success", message: "ファイルをゴミ箱に移動しました" }))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (error) {
      return ContentService
        .createTextOutput(JSON.stringify({ result: "error", message: error.toString() }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // デフォルト: 疎通確認用
  return ContentService
    .createTextOutput(JSON.stringify({ status: "ok", message: "声紋録音GASが正常に動作しています" }))
    .setMimeType(ContentService.MimeType.JSON);
}

// POSTリクエスト: 録音ファイルを保存 or Workersからの通知メール送信
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    // Cloudflare Workersからのメール通知モード（fileDataなし）
    if (data.type === "notification") {
      try {
        var subject = "【声紋録音】" + data.userName + "さんの録音が届きました";
        var body = [
          "声紋録音データが保存されました。",
          "",
          "■ お名前: " + data.userName,
          "■ ファイル名: " + data.fileName,
          "■ 録音日時: " + data.uploadedAt,
          "",
          "---",
          "声紋分析レコーダー 自動通知"
        ].join("\n");
        MailApp.sendEmail(NOTIFY_EMAIL, subject, body);
      } catch (mailError) {
        console.log("メール送信エラー: " + mailError.toString());
      }
      return ContentService
        .createTextOutput(JSON.stringify({ result: "success", message: "通知メール送信完了" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var base64 = data.fileData;
    var mimeType = data.mimeType || "audio/wav";
    var userName = data.userName || "unknown";

    // ファイル名: ユーザー名_日時.wav
    var sanitizedName = userName.replace(/[\\/:*?"<>|]/g, "_");
    var timestamp = Utilities.formatDate(new Date(), "JST", "yyyyMMdd_HHmmss");
    var fileName = sanitizedName + "_" + timestamp + ".wav";

    // Base64デコード
    var decoded = Utilities.base64Decode(base64);
    var blob = Utilities.newBlob(decoded, mimeType, fileName);

    // 専用フォルダに保存
    var folder = getOrCreateFolder();
    var file = folder.createFile(blob);

    // 管理画面から再生できるよう「リンクを知っている全員が閲覧可能」に設定
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    // Gmailで通知メールを送信
    try {
      var driveUrl = "https://drive.google.com/file/d/" + file.getId() + "/view";
      var subject = "【声紋録音】" + userName + "さんの録音が届きました";
      var body = [
        "声紋録音データが保存されました。",
        "",
        "■ お名前: " + userName,
        "■ ファイル名: " + file.getName(),
        "■ 録音日時: " + Utilities.formatDate(new Date(), "JST", "yyyy年MM月dd日 HH:mm:ss"),
        "■ Googleドライブで確認: " + driveUrl,
        "",
        "---",
        "声紋分析レコーダー 自動通知"
      ].join("\n");
      MailApp.sendEmail(NOTIFY_EMAIL, subject, body);
    } catch (mailError) {
      // メール送信失敗してもファイル保存は成功扱いにする
      console.log("メール送信エラー: " + mailError.toString());
    }

    return ContentService
      .createTextOutput(JSON.stringify({
        result: "success",
        fileId: file.getId(),
        fileName: file.getName(),
        folderName: FOLDER_NAME
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({
        result: "error",
        message: error.toString()
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// =========================================================
// テスト用: GASエディタから手動実行してMailApp権限を承認する
// メールが届かない場合は、この関数を選択して「▶ 実行」ボタンを押す
// =========================================================
function testSendEmail() {
  MailApp.sendEmail(
    NOTIFY_EMAIL,
    "【テスト】声紋録音GASのメール通知テスト",
    "GASのメール通知機能が正常に動作しています。"
  );
  Logger.log("メール送信完了: " + NOTIFY_EMAIL);
}
