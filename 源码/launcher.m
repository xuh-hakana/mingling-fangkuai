// 命令方块 · 原生客户端外壳（Objective-C + WKWebView）
// 编译：clang -fobjc-arc -framework Cocoa -framework WebKit launcher.m -o 命令方块
//
// 职责只有三件：
// 1. 起一个本地 Python 服务（127.0.0.1，随机端口）；
// 2. 等它健康检查通过，把页面装进原生窗口；
// 3. 退出时把子进程收干净。
// 页面逻辑、只读扫描、提词器数据全部在 Python / 前端里，这里不碰。

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <arpa/inet.h>
#import <netinet/in.h>
#import <sys/socket.h>
#import <unistd.h>

static NSTask *gServer = nil;
static NSString *gLogPath = nil;

static int FreeLoopbackPort(void) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return 0;
    int yes = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;
    int port = 0;
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0) {
        socklen_t len = sizeof(addr);
        if (getsockname(fd, (struct sockaddr *)&addr, &len) == 0) {
            port = ntohs(addr.sin_port);
        }
    }
    close(fd);
    return port;
}

static NSString *FindPython(void) {
    NSArray *candidates = @[
        @"/opt/homebrew/bin/python3",
        @"/usr/local/bin/python3",
        @"/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
        @"/usr/bin/python3",
    ];
    NSFileManager *fm = [NSFileManager defaultManager];
    for (NSString *path in candidates) {
        if ([fm isExecutableFileAtPath:path]) return path;
    }
    return nil;
}

static NSString *FindProjectRoot(NSString **outServerPath) {
    NSString *bundle = [[NSBundle mainBundle] bundlePath];
    NSString *appDir = [bundle stringByDeletingLastPathComponent];
    NSArray *roots = @[
        appDir,
        [bundle stringByAppendingPathComponent:@"Contents/Resources"],
        [[NSBundle mainBundle] resourcePath],
    ];
    NSFileManager *fm = [NSFileManager defaultManager];
    for (NSString *root in roots) {
        NSString *server = [root stringByAppendingPathComponent:@"server/server.py"];
        if ([fm fileExistsAtPath:server]) {
            if (outServerPath) *outServerPath = server;
            return root;
        }
    }
    return nil;
}

static void AppendLog(NSString *text) {
    if (!gLogPath) return;
    NSFileManager *fm = [NSFileManager defaultManager];
    if (![fm fileExistsAtPath:gLogPath]) {
        [fm createFileAtPath:gLogPath contents:[NSData data] attributes:nil];
    }
    NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:gLogPath];
    if (!handle) return;
    [handle seekToEndOfFile];
    [handle writeData:[[text stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding]];
    [handle closeFile];
}

@interface CommandBlockApp : NSObject <NSApplicationDelegate, NSWindowDelegate>
@property (strong) NSWindow *window;
@property (strong) WKWebView *webView;
@property (assign) int port;
@property (strong) NSTimer *pollTimer;
@property (assign) int tries;
@property (copy) NSString *pageURL;
@end

@implementation CommandBlockApp

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [self setupMenu];

    NSRect visible = [NSScreen mainScreen].visibleFrame;
    CGFloat width = MIN(1440.0, visible.size.width - 80.0);
    CGFloat height = MIN(900.0, visible.size.height - 80.0);
    NSRect frame = NSMakeRect(0, 0, width, height);
    NSWindowStyleMask mask = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                             NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable |
                             NSWindowStyleMaskFullSizeContentView;
    self.window = [[NSWindow alloc] initWithContentRect:frame
                                             styleMask:mask
                                               backing:NSBackingStoreBuffered
                                                 defer:NO];
    self.window.title = @"命令方块";
    self.window.titlebarAppearsTransparent = YES;
    self.window.titleVisibility = NSWindowTitleHidden;
    self.window.movableByWindowBackground = YES;
    self.window.minSize = NSMakeSize(1040, 680);
    self.window.delegate = self;
    self.window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
    [self.window setFrameAutosaveName:@"CommandBlockMainWindow"];
    [self.window center];

    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    config.websiteDataStore = [WKWebsiteDataStore defaultDataStore];
    NSString *bootstrap =
        @"document.documentElement.classList.add('is-app');";
    WKUserScript *script = [[WKUserScript alloc] initWithSource:bootstrap
                                                 injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                              forMainFrameOnly:YES];
    [config.userContentController addUserScript:script];

    self.webView = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds
                                      configuration:config];
    self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [self.window.contentView addSubview:self.webView];

    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];

    [self showLoading:@"正在启动本地服务…"];
    if (![self startServer]) return;

    self.tries = 0;
    self.pollTimer = [NSTimer scheduledTimerWithTimeInterval:0.4
                                                      target:self
                                                    selector:@selector(pollHealth)
                                                    userInfo:nil
                                                     repeats:YES];
}

- (BOOL)startServer {
    NSString *serverPath = nil;
    NSString *root = FindProjectRoot(&serverPath);
    if (!root || !serverPath) {
        [self showError:@"找不到 server/server.py"
                 detail:@"请把「命令方块.app」留在 命令方块 文件夹里，不要单独拖到别处。"];
        return NO;
    }
    NSString *python = FindPython();
    if (!python) {
        [self showError:@"没有找到 python3"
                 detail:@"先装 Python 3.9 或更新版本：https://www.python.org/downloads/macos/ ，装完再双击一次。"];
        return NO;
    }
    self.port = FreeLoopbackPort();
    if (self.port <= 0) {
        [self showError:@"找不到可用端口" detail:@"可能太多本地服务在跑，重启一次电脑再试。"];
        return NO;
    }

    NSString *dataDir = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/CommandBlock"];
    [[NSFileManager defaultManager] createDirectoryAtPath:dataDir
                              withIntermediateDirectories:YES
                                               attributes:nil
                                                    error:nil];
    gLogPath = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Logs/CommandBlock.log"];

    gServer = [[NSTask alloc] init];
    gServer.executableURL = [NSURL fileURLWithPath:python];
    gServer.arguments = @[
        @"-u",
        serverPath,
        @"--port", [NSString stringWithFormat:@"%d", self.port],
        @"--no-open",
        @"--data-dir", dataDir,
        @"--parent-pid", [NSString stringWithFormat:@"%d", NSProcessInfo.processInfo.processIdentifier],
    ];
    gServer.currentDirectoryURL = [NSURL fileURLWithPath:[serverPath stringByDeletingLastPathComponent]];

    NSFileManager *fm = [NSFileManager defaultManager];
    if (![fm fileExistsAtPath:gLogPath]) {
        [fm createFileAtPath:gLogPath contents:[NSData data] attributes:nil];
    }
    NSFileHandle *logHandle = [NSFileHandle fileHandleForWritingAtPath:gLogPath];
    if (logHandle) {
        [logHandle seekToEndOfFile];
        gServer.standardOutput = logHandle;
        gServer.standardError = logHandle;
    }

    NSError *error = nil;
    if (![gServer launchAndReturnError:&error]) {
        [self showError:@"本地服务启动失败" detail:error.localizedDescription ?: @"未知错误"];
        return NO;
    }
    // 深链接：外部可用 COMMAND_BLOCK_HASH="#/file?path=..." 直接打开某个页面。
    NSString *hash = NSProcessInfo.processInfo.environment[@"COMMAND_BLOCK_HASH"] ?: @"";
    self.pageURL = [NSString stringWithFormat:@"http://127.0.0.1:%d/%@", self.port, hash];
    return YES;
}

- (void)pollHealth {
    self.tries += 1;
    if (self.tries > 60) {
        [self.pollTimer invalidate];
        self.pollTimer = nil;
        [self showError:@"本地服务没有响应"
                 detail:[NSString stringWithFormat:@"看了 24 秒还没起来。日志在 %@，把最后几行发给我就能定位。", gLogPath ?: @"~/Library/Logs/CommandBlock.log"]];
        return;
    }
    if (!gServer || !gServer.isRunning) {
        [self.pollTimer invalidate];
        self.pollTimer = nil;
        [self showError:@"本地服务已经退出"
                 detail:[NSString stringWithFormat:@"日志在 %@。常见原因是 Python 版本太旧或端口被占用。", gLogPath ?: @"~/Library/Logs/CommandBlock.log"]];
        return;
    }
    NSString *health = [NSString stringWithFormat:@"http://127.0.0.1:%d/api/health", self.port];
    NSURLSessionDataTask *task = [[NSURLSession sharedSession] dataTaskWithURL:[NSURL URLWithString:health]
                                                            completionHandler:^(NSData *data, NSURLResponse *response, NSError *err) {
        NSInteger code = [(NSHTTPURLResponse *)response statusCode];
        if (code == 200) {
            dispatch_async(dispatch_get_main_queue(), ^{
                [self.pollTimer invalidate];
                self.pollTimer = nil;
                [self loadApp];
            });
        }
    }];
    [task resume];
}

- (void)loadApp {
    NSURLRequest *request = [NSURLRequest requestWithURL:[NSURL URLWithString:self.pageURL]
                                             cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                                         timeoutInterval:20];
    [self.webView loadRequest:request];
}

- (void)showLoading:(NSString *)text {
    NSString *html = [NSString stringWithFormat:
        @"<!doctype html><meta charset='utf-8'>"
         "<style>body{margin:0;height:100vh;display:grid;place-items:center;"
         "background:#f3efe6;font-family:-apple-system,'PingFang SC',sans-serif;color:#7f838b}"
         ".box{text-align:center}.cube{width:34px;height:34px;margin:0 auto 14px;border-radius:8px;"
         "background:#20242b;position:relative}.cube::after{content:'';position:absolute;inset:9px;"
         "background:#c64f2a;border-radius:3px}"
         "p{font-size:12px;letter-spacing:.02em}</style>"
         "<div class='box'><div class='cube'></div><p>%@</p></div>", text];
    [self.webView loadHTMLString:html baseURL:nil];
}

- (void)showError:(NSString *)title detail:(NSString *)detail {
    NSString *html = [NSString stringWithFormat:
        @"<!doctype html><meta charset='utf-8'>"
         "<style>body{margin:0;height:100vh;display:grid;place-items:center;"
         "background:#f3efe6;font-family:-apple-system,'PingFang SC',sans-serif;color:#20242b}"
         ".card{max-width:520px;padding:28px 30px;background:#fdfbf6;border:1px solid #e5dfd2;"
         "border-radius:14px;box-shadow:0 20px 60px rgba(42,33,19,.12)}"
         "h1{margin:0 0 8px;font-size:19px;letter-spacing:-.02em}"
         "p{margin:0;font-size:12.5px;line-height:1.7;color:#555b64}"
         ".tag{display:inline-block;margin-bottom:12px;padding:3px 8px;border-radius:5px;"
         "background:#f7e5e2;color:#a94138;font-size:10px;letter-spacing:.06em}</style>"
         "<div class='card'><span class='tag'>启动失败</span><h1>%@</h1><p>%@</p></div>",
         title, detail];
    [self.webView loadHTMLString:html baseURL:nil];
}

- (void)setupMenu {
    NSMenu *mainMenu = [[NSMenu alloc] init];

    NSMenuItem *appItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:appItem];
    NSMenu *appMenu = [[NSMenu alloc] init];
    [appMenu addItemWithTitle:@"关于 命令方块" action:@selector(orderFrontStandardAboutPanel:) keyEquivalent:@""];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:@"隐藏 命令方块" action:@selector(hide:) keyEquivalent:@"h"];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:@"退出 命令方块" action:@selector(terminate:) keyEquivalent:@"q"];
    appItem.submenu = appMenu;

    NSMenuItem *editItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:editItem];
    NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"编辑"];
    [editMenu addItemWithTitle:@"撤销" action:@selector(undo:) keyEquivalent:@"z"];
    NSMenuItem *redo = [editMenu addItemWithTitle:@"重做" action:@selector(redo:) keyEquivalent:@"z"];
    redo.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagShift;
    [editMenu addItem:[NSMenuItem separatorItem]];
    [editMenu addItemWithTitle:@"剪切" action:@selector(cut:) keyEquivalent:@"x"];
    [editMenu addItemWithTitle:@"拷贝" action:@selector(copy:) keyEquivalent:@"c"];
    [editMenu addItemWithTitle:@"粘贴" action:@selector(paste:) keyEquivalent:@"v"];
    [editMenu addItemWithTitle:@"全选" action:@selector(selectAll:) keyEquivalent:@"a"];
    editItem.submenu = editMenu;

    NSMenuItem *viewItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:viewItem];
    NSMenu *viewMenu = [[NSMenu alloc] initWithTitle:@"视图"];
    [viewMenu addItemWithTitle:@"重新载入" action:@selector(reloadPage) keyEquivalent:@"r"];
    [viewMenu addItemWithTitle:@"回到首页" action:@selector(goHome) keyEquivalent:@"0"];
    NSMenuItem *zoomIn = [viewMenu addItemWithTitle:@"放大" action:@selector(zoomIn) keyEquivalent:@"+"];
    zoomIn.keyEquivalentModifierMask = NSEventModifierFlagCommand;
    [viewMenu addItemWithTitle:@"缩小" action:@selector(zoomOut) keyEquivalent:@"-"];
    [viewMenu addItemWithTitle:@"实际大小" action:@selector(zoomReset) keyEquivalent:@"0"];
    viewItem.submenu = viewMenu;

    NSMenuItem *windowItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:windowItem];
    NSMenu *windowMenu = [[NSMenu alloc] initWithTitle:@"窗口"];
    [windowMenu addItemWithTitle:@"最小化" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
    [windowMenu addItemWithTitle:@"缩放" action:@selector(performZoom:) keyEquivalent:@""];
    windowItem.submenu = windowMenu;

    NSApp.mainMenu = mainMenu;
    NSApp.windowsMenu = windowMenu;
}

- (void)reloadPage {
    if (self.pageURL) [self.webView loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:self.pageURL]]];
}

- (void)goHome {
    if (self.pageURL) [self.webView loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:self.pageURL]]];
}

- (void)zoomIn {
    self.webView.pageZoom = MIN(2.0, self.webView.pageZoom + 0.1);
}

- (void)zoomOut {
    self.webView.pageZoom = MAX(0.6, self.webView.pageZoom - 0.1);
}

- (void)zoomReset {
    self.webView.pageZoom = 1.0;
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    return YES;
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    if (self.pollTimer) [self.pollTimer invalidate];
    if (gServer && gServer.isRunning) {
        AppendLog(@"[launcher] terminating server");
        [gServer terminate];
        [gServer waitUntilExit];
    }
}

@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        CommandBlockApp *delegate = [[CommandBlockApp alloc] init];
        app.delegate = delegate;
        [app run];
    }
    return 0;
}
