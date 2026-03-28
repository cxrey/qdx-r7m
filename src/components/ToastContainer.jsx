/**
 * ToastContainer — displays transient notification toasts.
 */
export default function ToastContainer({ toasts, onRemove }) {
  if (!toasts || toasts.length === 0) return null;

  return (
    <div className="fixed top-16 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex items-center gap-2 px-3 py-2 rounded-lg shadow-lg text-xs font-medium animate-slide-in ${
            toast.type === 'success' ? 'bg-emerald-900/90 text-emerald-300 border border-emerald-700/50' :
            toast.type === 'warn' ? 'bg-yellow-900/90 text-yellow-300 border border-yellow-700/50' :
            toast.type === 'error' ? 'bg-red-900/90 text-red-300 border border-red-700/50' :
            'bg-gray-800/90 text-gray-300 border border-gray-700/50'
          }`}
        >
          <span className="flex-1">{toast.message}</span>
          <button
            onClick={() => onRemove(toast.id)}
            className="text-gray-500 hover:text-gray-300 ml-2"
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
