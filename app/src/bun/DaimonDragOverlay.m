#import <Cocoa/Cocoa.h>

// Transparent NSView subclass covering the title bar zone.
// mouseDragged: starts the native drag so mouseDown: is free to detect double-clicks.
// hitTest: passes through the traffic-lights zone (x < 80).
@interface DaimonDragOverlay : NSView {
    NSEvent *_pendingMouseDown;
}
@end

@implementation DaimonDragOverlay

- (BOOL)isOpaque { return NO; }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }

- (NSView *)hitTest:(NSPoint)point {
    // point is in superview coords; convert to our frame origin
    NSPoint local = [self convertPoint:point fromView:self.superview];
    if (local.x < 80) return nil; // pass through to traffic lights
    return [super hitTest:point];
}

- (void)mouseDown:(NSEvent *)event {
    NSLog(@"[DaimonDrag] mouseDown clickCount=%ld", (long)event.clickCount);
    if (event.clickCount == 2) {
        _pendingMouseDown = nil;
        NSLog(@"[DaimonDrag] calling zoom:");
        [self.window zoom:self];
    } else {
        _pendingMouseDown = event;
    }
}

- (void)mouseDragged:(NSEvent *)event {
    if (_pendingMouseDown) {
        NSEvent *down = _pendingMouseDown;
        _pendingMouseDown = nil;
        [self.window performWindowDragWithEvent:down];
    }
}

- (void)mouseUp:(NSEvent *)event {
    _pendingMouseDown = nil;
}

@end

// Called from bun:ffi — dispatches to main thread internally.
void DaimonDragInstall(NSWindow *window, CGFloat titlebarHeight) {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSView *contentView = window.contentView;
        if (!contentView) return;

        // Remove any existing overlay (hot-reload safety).
        for (NSView *v in contentView.subviews.copy) {
            if ([v isKindOfClass:[DaimonDragOverlay class]]) {
                [v removeFromSuperview];
            }
        }

        NSRect frame = contentView.bounds;
        NSRect overlayFrame = NSMakeRect(0, frame.size.height - titlebarHeight,
                                         frame.size.width, titlebarHeight);

        DaimonDragOverlay *overlay = [[DaimonDragOverlay alloc] initWithFrame:overlayFrame];
        overlay.autoresizingMask = NSViewWidthSizable | NSViewMinYMargin;
        overlay.wantsLayer = YES;
        overlay.layer.backgroundColor = NSColor.clearColor.CGColor;

        [contentView addSubview:overlay];
        NSLog(@"[DaimonDrag] overlay installed (%@)", NSStringFromRect(overlayFrame));
    });
}
