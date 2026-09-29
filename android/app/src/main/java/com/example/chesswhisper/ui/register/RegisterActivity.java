package com.example.chesswhisper.ui.register;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.EdgeToEdge;
import androidx.activity.SystemBarStyle;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import androidx.lifecycle.ViewModelProvider;

import com.example.chesswhisper.R;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.textfield.TextInputEditText;

// The register screen. It only collects input and renders state — all the rules
// (what a valid password is, whether a username is taken) live on the server.
public class RegisterActivity extends AppCompatActivity {
    private TextInputEditText usernameInput;
    private TextInputEditText passwordInput;
    private TextView errorText;
    private MaterialButton submitBotton;
    private ProgressBar progressBar;
    private RegisterViewModel viewModel;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Draws behind the status and navigation bars; the listener below then
        // pads the content back out from underneath them.
        // Light bar icons always — the app is dark-only (see HomeActivity).
        EdgeToEdge.enable(this,
                SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT));
        setContentView(R.layout.activity_register);
        int base=getResources().getDimensionPixelSize(R.dimen.screen_padding);
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.register), (v, insets) -> {
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
        usernameInput= findViewById(R.id.usernameInput);
        passwordInput= findViewById(R.id.passwordInput);
        errorText=findViewById(R.id.errorText);
        submitBotton=findViewById(R.id.submitButton);
        progressBar=findViewById(R.id.progressBar);
        // Tied to this Activity, so the same instance comes back after a rotation.
        viewModel= new ViewModelProvider(this).get(RegisterViewModel.class);
        // Observing with "this" as the owner: updates stop while the screen is not
        // visible and the subscription is dropped automatically on destroy.
        viewModel.getState().observe(this,state -> render(state));
        // No validation here on purpose — the request goes out and the server
        // decides, so there is only one copy of the rules.
        submitBotton.setOnClickListener(v-> viewModel.register(
                usernameInput.getText().toString(),
                passwordInput.getText().toString()
        ));
        // Same effect as the system back gesture; this is just a visible affordance.
        findViewById(R.id.backButton).setOnClickListener(v -> finish());
    }

    // Single place that turns a state into what is on screen. Every branch sets
    // both the visible and the invisible case, so no stale spinner or error
    // survives into the next state.
    public void render(RegisterViewModel.RegisterState state){
        if(state.status==RegisterViewModel.Status.LOADING){
            progressBar.setVisibility(View.VISIBLE);
            submitBotton.setEnabled(false);
        } else{
            progressBar.setVisibility(View.GONE);
            submitBotton.setEnabled(true);
        }
        if (state.status == RegisterViewModel.Status.ERROR && state.error != null) {
            errorText.setText(state.error.getMessage());
            errorText.setVisibility(View.VISIBLE);
        } else {
            errorText.setVisibility(View.GONE);
        }
        if (state.status == RegisterViewModel.Status.SUCCESS) {
            // Confirm and close. Registering does not log the user in — there is
            // no session yet and no home screen to go to until CW-11 and CW-12.
            Toast.makeText(this, R.string.register_success, Toast.LENGTH_LONG).show();
            finish();
        }
    }
}