package com.example.chesswhisper.ui;

import android.os.Bundle;
import android.content.Intent;
import android.view.View;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.activity.EdgeToEdge;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.lifecycle.ViewModelProvider;

import com.example.chesswhisper.R;
import com.example.chesswhisper.data.auth.SessionManager;
import com.example.chesswhisper.ui.register.RegisterActivity;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.textfield.TextInputEditText;

// The launcher activity — and, per CLAUDE.md's "MainActivity is the login
// screen" decision, the login screen itself, not a router to a separate one.
public class MainActivity extends AppCompatActivity {
    private TextInputEditText usernameInput;
    private TextInputEditText passwordInput;
    private TextView errorText;
    private MaterialButton submitButton;
    private ProgressBar progressBar;
    private MainViewModel viewModel;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Checked before any UI is inflated: reopening the app with a stored
        // session goes straight to Home, the login form is never shown.
        if (SessionManager.getInstance().hasSession()) {
            startActivity(new Intent(this, HomeActivity.class));
            finish();
            return;
        }

        // Draws behind the status and navigation bars; the listener below then
        // pads the content back out from underneath them.
        EdgeToEdge.enable(this);
        setContentView(R.layout.activity_main);
        int base = getResources().getDimensionPixelSize(R.dimen.screen_padding);
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.main), (v, insets) -> {
            Insets systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            // setPadding replaces padding rather than adding to it, so the screen's
            // own 24dp is added here instead of being set in the layout XML.
            v.setPadding(
                    systemBars.left + base,
                    systemBars.top + base,
                    systemBars.right + base,
                    systemBars.bottom + base);
            return insets;
        });

        usernameInput = findViewById(R.id.usernameInput);
        passwordInput = findViewById(R.id.passwordInput);
        errorText = findViewById(R.id.errorText);
        submitButton = findViewById(R.id.submitButton);
        progressBar = findViewById(R.id.progressBar);

        // Tied to this Activity, so the same instance comes back after a rotation.
        viewModel = new ViewModelProvider(this).get(MainViewModel.class);
        // Observing with "this" as the owner: updates stop while the screen is not
        // visible and the subscription is dropped automatically on destroy.
        viewModel.getState().observe(this, this::render);

        // No validation here on purpose — the request goes out and the server
        // decides, so there is only one copy of the rules.
        submitButton.setOnClickListener(v -> viewModel.login(
                usernameInput.getText().toString(),
                passwordInput.getText().toString()
        ));
        // The "Don't have an account? Register" link.
        findViewById(R.id.registerLink).setOnClickListener(v ->
                startActivity(new Intent(this, RegisterActivity.class)));
    }

    // Single place that turns a state into what is on screen. Every branch sets
    // both the visible and the invisible case, so no stale spinner or error
    // survives into the next state.
    private void render(MainViewModel.LoginState state) {
        if (state.status == MainViewModel.Status.LOADING) {
            progressBar.setVisibility(View.VISIBLE);
            submitButton.setEnabled(false);
        } else {
            progressBar.setVisibility(View.GONE);
            submitButton.setEnabled(true);
        }
        if (state.status == MainViewModel.Status.ERROR && state.error != null) {
            errorText.setText(state.error.getMessage());
            errorText.setVisibility(View.VISIBLE);
        } else {
            errorText.setVisibility(View.GONE);
        }
        if (state.status == MainViewModel.Status.SUCCESS) {
            // The session is already saved (AuthRepository.login) — the only
            // thing left to do is take the user to the home screen.
            startActivity(new Intent(this, HomeActivity.class));
            finish();
        }
    }
}
