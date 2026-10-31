//! Keeps mouse events in order while a text field is focused.
//!
//! With an editable element focused, WebKit routes each mouse event through
//! `-[NSTextInputContext handleEvent:completionHandler:]` and only delivers it from the callback.
//! Under Squirrel, a tap whose press and release are under 1ms apart then reaches the page release
//! first, leaving a press that never ends: tabs stick to the pointer and TUIs see a drag. WebKit
//! skips that route when the view has no input context, so report none for the length of each
//! mouse call. Keyboard input and composition still see the real one.
use std::cell::Cell;
use std::collections::HashMap;
use std::sync::OnceLock;

use objc2::ffi;
use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::sel;

thread_local! {
    static BYPASSING: Cell<bool> = const { Cell::new(false) };
}

struct Originals {
    input_context: Imp,
    mouse: HashMap<Sel, Imp>,
}

static ORIGINALS: OnceLock<Originals> = OnceLock::new();

type MouseImp = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject);
type InputContextImp = unsafe extern "C-unwind" fn(*mut AnyObject, Sel) -> *mut AnyObject;

/// Every selector WebKit sends through its mouse event handler.
fn mouse_selectors() -> [Sel; 12] {
    [
        sel!(mouseDown:),
        sel!(mouseUp:),
        sel!(mouseDragged:),
        sel!(mouseMoved:),
        sel!(mouseEntered:),
        sel!(mouseExited:),
        sel!(rightMouseDown:),
        sel!(rightMouseUp:),
        sel!(rightMouseDragged:),
        sel!(otherMouseDown:),
        sel!(otherMouseUp:),
        sel!(otherMouseDragged:),
    ]
}

unsafe extern "C-unwind" fn forward_mouse_event(
    this: *mut AnyObject,
    sel: Sel,
    event: *mut AnyObject,
) {
    let Some(original) = ORIGINALS.get().and_then(|o| o.mouse.get(&sel)) else {
        return;
    };
    let original = unsafe { std::mem::transmute::<Imp, MouseImp>(*original) };
    // wry's otherMouseDown: calls mouseDown:, so restore rather than clear.
    let previous = BYPASSING.replace(true);
    unsafe { original(this, sel, event) };
    BYPASSING.set(previous);
}

unsafe extern "C-unwind" fn input_context(this: *mut AnyObject, sel: Sel) -> *mut AnyObject {
    if BYPASSING.get() {
        return std::ptr::null_mut();
    }
    let Some(originals) = ORIGINALS.get() else {
        return std::ptr::null_mut();
    };
    let original = unsafe { std::mem::transmute::<Imp, InputContextImp>(originals.input_context) };
    unsafe { original(this, sel) }
}

/// Points `sel` at `replacement` on `class` itself, returning what it resolved to before.
unsafe fn replace_method(class: &AnyClass, sel: Sel, replacement: Imp) -> Option<Imp> {
    let method = class.instance_method(sel)?;
    let original = method.implementation();
    let class_ptr = class as *const AnyClass as *mut AnyClass;
    let types = unsafe { ffi::method_getTypeEncoding(method) };
    // Adding overrides an inherited method; it fails only if `class` defines `sel` itself.
    if !unsafe { ffi::class_addMethod(class_ptr, sel, replacement, types) }.as_bool() {
        unsafe { method.set_implementation(replacement) };
    }
    Some(original)
}

fn hook(class: &AnyClass) {
    if ORIGINALS.get().is_some() {
        return;
    }
    let forward = unsafe {
        std::mem::transmute::<unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject), Imp>(
            forward_mouse_event,
        )
    };
    let context = unsafe {
        std::mem::transmute::<unsafe extern "C-unwind" fn(*mut AnyObject, Sel) -> *mut AnyObject, Imp>(
            input_context,
        )
    };
    let Some(original_context) = class
        .instance_method(sel!(inputContext))
        .map(|method| method.implementation())
    else {
        log::warn!("web view has no inputContext; mouse events stay as they are");
        return;
    };
    let mouse = mouse_selectors()
        .into_iter()
        .filter_map(|sel| {
            class
                .instance_method(sel)
                .map(|m| (sel, m.implementation()))
        })
        .collect();
    // Published before the methods change, so a replacement always finds its original.
    let _ = ORIGINALS.set(Originals {
        input_context: original_context,
        mouse,
    });
    unsafe {
        replace_method(class, sel!(inputContext), context);
        for sel in mouse_selectors() {
            replace_method(class, sel, forward);
        }
    }
}

/// Hooks the class of `window`'s web view, which every window's web view shares. The class comes
/// from the instance because wry's runtime class name embeds its module path and version.
pub fn install(window: &tauri::WebviewWindow) {
    let result = window.with_webview(|platform| unsafe {
        let webview = platform.inner() as *const AnyObject;
        // `-class`, not the isa pointer, so a KVO-generated subclass can't be hooked by mistake.
        let class: &AnyClass = msg_send![webview, class];
        hook(class);
        log::info!(
            "mouse events bypass the input context on {}",
            class.name().to_string_lossy()
        );
    });
    if let Err(error) = result {
        log::warn!("could not hook the web view's mouse events: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::runtime::{ClassBuilder, NSObject};
    use objc2::ClassType;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static CONTEXT_DURING_MOUSE: AtomicUsize = AtomicUsize::new(usize::MAX);
    static MOUSE_CALLS: AtomicUsize = AtomicUsize::new(0);

    extern "C-unwind" fn base_input_context(this: *mut AnyObject, _: Sel) -> *mut AnyObject {
        this
    }

    extern "C-unwind" fn base_mouse_down(this: *mut AnyObject, _: Sel, _: *mut AnyObject) {
        let context: *mut AnyObject = unsafe { msg_send![this, inputContext] };
        CONTEXT_DURING_MOUSE.store(context as usize, Ordering::SeqCst);
        MOUSE_CALLS.fetch_add(1, Ordering::SeqCst);
    }

    extern "C-unwind" fn nested_mouse_up(this: *mut AnyObject, _: Sel, event: *mut AnyObject) {
        let _: () = unsafe { msg_send![this, mouseDown: event] };
    }

    /// The methods live on a superclass, as WKWebView's do beneath WryWebView.
    #[test]
    fn hides_the_input_context_only_during_mouse_calls() {
        let mut base =
            ClassBuilder::new(c"MouseInputContextTestBase", NSObject::class()).expect("base");
        unsafe {
            base.add_method(
                sel!(inputContext),
                base_input_context as extern "C-unwind" fn(_, _) -> _,
            );
            base.add_method(
                sel!(mouseDown:),
                base_mouse_down as extern "C-unwind" fn(_, _, _),
            );
            base.add_method(
                sel!(mouseUp:),
                nested_mouse_up as extern "C-unwind" fn(_, _, _),
            );
        }
        let base = base.register();
        let derived = ClassBuilder::new(c"MouseInputContextTestDerived", base)
            .expect("derived")
            .register();

        hook(derived);

        unsafe {
            let view: *mut AnyObject = msg_send![derived, new];
            let before: *mut AnyObject = msg_send![view, inputContext];
            assert_eq!(before, view);

            let event: *mut AnyObject = std::ptr::null_mut();
            let _: () = msg_send![view, mouseDown: event];
            assert_eq!(CONTEXT_DURING_MOUSE.load(Ordering::SeqCst), 0);
            assert_eq!(MOUSE_CALLS.load(Ordering::SeqCst), 1);

            let after: *mut AnyObject = msg_send![view, inputContext];
            assert_eq!(after, view);

            // A mouse call made from inside another must not end the outer one's bypass early.
            CONTEXT_DURING_MOUSE.store(usize::MAX, Ordering::SeqCst);
            let _: () = msg_send![view, mouseUp: event];
            assert_eq!(CONTEXT_DURING_MOUSE.load(Ordering::SeqCst), 0);
            let after_nested: *mut AnyObject = msg_send![view, inputContext];
            assert_eq!(after_nested, view);
        }
    }
}
